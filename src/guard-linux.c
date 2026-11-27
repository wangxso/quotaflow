#define _GNU_SOURCE
#include <ctype.h>
#include <dirent.h>
#include <errno.h>
#include <fcntl.h>
#include <limits.h>
#include <poll.h>
#include <signal.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/prctl.h>
#include <sys/wait.h>
#include <time.h>
#include <unistd.h>

extern char **environ;
static int status_dir;
static volatile sig_atomic_t termination_signal;
static pid_t supervising_owner;

#define MAX_TRACKED_PROCESSES 4096

typedef struct process_info {
  pid_t pid;
  pid_t ppid;
  pid_t pgid;
  pid_t session;
  uint64_t start_time;
  char state;
} process_info;

typedef struct tracked_process {
  pid_t pid;
  pid_t pgid;
  pid_t session;
  uint64_t start_time;
} tracked_process;

typedef struct process_tracker {
  tracked_process entries[MAX_TRACKED_PROCESSES];
  size_t count;
} process_tracker;

static void request_termination(int signal_number)
{
  termination_signal = signal_number;
}

static bool environment_enabled(const char *name)
{
  const char *value = getenv(name);
  return value && strcmp(value, "1") == 0;
}

static bool publish(const char *name, const char *json)
{
  char pending[64];
  snprintf(pending, sizeof pending, "%s.%d.pending", name, getpid());
  int fd = openat(status_dir, pending, O_WRONLY | O_CREAT | O_EXCL, 0600);
  if (fd < 0) return false;
  bool written = write(fd, json, strlen(json)) == (ssize_t)strlen(json);
  if (close(fd) == 0 && written && renameat(status_dir, pending, status_dir, name) == 0) return true;
  unlinkat(status_dir, pending, 0);
  return false;
}

static int publish_stop(pid_t worker, const char *reason, int exit_code)
{
  char code[16] = "null";
  if (exit_code >= 0) snprintf(code, sizeof code, "%d", exit_code);
  char json[192];
  snprintf(json, sizeof json,
    "{\"supervisorPid\":%d,\"workerPid\":%d,\"exitCode\":%s,\"activeProcesses\":0,\"reason\":\"%s\"}",
    getpid(), worker, code, reason);
  if (publish("stopped.json", json)) return 0;
  perror("publish stopped.json");
  return 70;
}

static int launch_worker(char *const command[], pid_t *worker, bool proxy_stdio)
{
  int log = -1;
  if (!proxy_stdio) {
    log = openat(status_dir, "worker.log", O_WRONLY | O_CREAT | O_TRUNC | O_CLOEXEC, 0600);
    if (log < 0) return errno;
  }
  pid_t child = fork();
  if (child < 0) {
    int error = errno;
    if (log >= 0) close(log);
    return error;
  }
  if (child == 0) {
    if (setsid() < 0) _exit(126);
    if (prctl(PR_SET_PDEATHSIG, SIGKILL) < 0) _exit(126);
    if (!proxy_stdio) {
      int null_fd = open("/dev/null", O_RDONLY | O_CLOEXEC);
      if (null_fd < 0 || dup2(null_fd, STDIN_FILENO) < 0) _exit(126);
      if (null_fd != STDIN_FILENO) close(null_fd);
      if (dup2(log, STDOUT_FILENO) < 0 || dup2(log, STDERR_FILENO) < 0) _exit(126);
    }
    if (log >= 0 && log != STDERR_FILENO) close(log);
    execvp(command[0], command);
    _exit(errno == ENOENT ? 127 : 126);
  }
  if (log >= 0) close(log);
  *worker = child;
  return 0;
}

static int read_process(pid_t pid, process_info *process)
{
  if (pid <= 0) return 0;
  char path[64];
  snprintf(path, sizeof path, "/proc/%d/stat", pid);
  int fd = open(path, O_RDONLY | O_CLOEXEC);
  if (fd < 0) return (errno == ENOENT || errno == ESRCH) ? 0 : -1;
  char data[4096];
  ssize_t length = read(fd, data, sizeof data - 1);
  close(fd);
  if (length <= 0) return (length == 0 || errno == ENOENT) ? 0 : -1;
  data[length] = '\0';
  char *close_name = strrchr(data, ')');
  if (!close_name || close_name[1] != ' ') {
    errno = EIO;
    return -1;
  }
  char *cursor = close_name + 2;
  if (!*cursor) {
    errno = EIO;
    return -1;
  }
  process->pid = pid;
  process->state = *cursor;
  char *save = NULL;
  char *token = strtok_r(cursor, " \n", &save);
  int field = 3;
  while (token && field < 22) {
    token = strtok_r(NULL, " \n", &save);
    field++;
    if (!token) break;
    errno = 0;
    if (field == 4) process->ppid = (pid_t)strtol(token, NULL, 10);
    else if (field == 5) process->pgid = (pid_t)strtol(token, NULL, 10);
    else if (field == 6) process->session = (pid_t)strtol(token, NULL, 10);
    else if (field == 22) process->start_time = strtoull(token, NULL, 10);
    if (errno) return -1;
  }
  if (field != 22 || process->ppid <= 0 || process->pgid <= 0 || process->session <= 0) {
    errno = EIO;
    return -1;
  }
  return 1;
}

static int load_processes(process_info processes[], size_t capacity, size_t *count)
{
  DIR *directory = opendir("/proc");
  if (!directory) return -1;
  *count = 0;
  struct dirent *entry;
  while ((entry = readdir(directory)) != NULL) {
    if (!isdigit((unsigned char)entry->d_name[0])) continue;
    char *end = NULL;
    long value = strtol(entry->d_name, &end, 10);
    if (!end || *end || value <= 1 || value > INT_MAX) continue;
    if (*count == capacity) {
      closedir(directory);
      errno = EOVERFLOW;
      return -1;
    }
    process_info process = {0};
    int result = read_process((pid_t)value, &process);
    if (result < 0) {
      closedir(directory);
      return -1;
    }
    if (result > 0) processes[(*count)++] = process;
  }
  closedir(directory);
  return 0;
}

static bool same_process(const tracked_process *tracked, const process_info *process)
{
  return tracked->pid == process->pid && tracked->start_time == process->start_time;
}

static int track_process(process_tracker *tracker, const process_info *process)
{
  if (process->pid <= 1 || process->pid == getpid() || process->pid == supervising_owner) return 0;
  for (size_t index = 0; index < tracker->count; index++) {
    if (tracker->entries[index].pid != process->pid) continue;
    tracker->entries[index] = (tracked_process) {
      .pid = process->pid,
      .pgid = process->pgid,
      .session = process->session,
      .start_time = process->start_time,
    };
    return 0;
  }
  if (tracker->count == MAX_TRACKED_PROCESSES) {
    errno = EOVERFLOW;
    return -1;
  }
  tracker->entries[tracker->count++] = (tracked_process) {
    .pid = process->pid,
    .pgid = process->pgid,
    .session = process->session,
    .start_time = process->start_time,
  };
  return 1;
}

static bool related_to_tracker(const process_info *process, const process_tracker *tracker)
{
  if (process->ppid == getpid()) return true;
  for (size_t index = 0; index < tracker->count; index++) {
    const tracked_process *tracked = &tracker->entries[index];
    if (process->ppid == tracked->pid
      || process->pgid == tracked->pgid
      || process->session == tracked->session) return true;
  }
  return false;
}

static int collect_process_tree(process_tracker *tracker, pid_t worker)
{
  process_info processes[MAX_TRACKED_PROCESSES];
  size_t count = 0;
  if (load_processes(processes, MAX_TRACKED_PROCESSES, &count) < 0) return -1;
  for (size_t index = 0; index < count; index++) {
    if (processes[index].pid == worker && track_process(tracker, &processes[index]) < 0) return -1;
  }
  bool changed;
  do {
    changed = false;
    for (size_t index = 0; index < count; index++) {
      if (!related_to_tracker(&processes[index], tracker)) continue;
      int tracked = track_process(tracker, &processes[index]);
      if (tracked < 0) return -1;
      if (tracked > 0) changed = true;
    }
  } while (changed);
  return 0;
}

static int signal_tracked_processes(process_tracker *tracker, pid_t worker, int signal_number)
{
  if (kill(-worker, signal_number) < 0 && errno != ESRCH && errno != EPERM) return -1;
  const pid_t own_group = getpgrp();
  for (size_t index = 0; index < tracker->count; index++) {
    process_info current = {0};
    int known = read_process(tracker->entries[index].pid, &current);
    if (known < 0) return -1;
    if (known == 0 || !same_process(&tracker->entries[index], &current) || current.state == 'Z') continue;
    if (kill(current.pid, signal_number) < 0 && errno != ESRCH && errno != EPERM) return -1;
    if (current.pgid > 1 && current.pgid != own_group
      && kill(-current.pgid, signal_number) < 0 && errno != ESRCH && errno != EPERM) return -1;
  }
  return 0;
}

static int active_process_count(process_tracker *tracker, pid_t worker)
{
  if (collect_process_tree(tracker, worker) < 0) return -1;
  int active = 0;
  for (size_t index = 0; index < tracker->count; index++) {
    process_info current = {0};
    int known = read_process(tracker->entries[index].pid, &current);
    if (known < 0) return -1;
    if (known > 0 && same_process(&tracker->entries[index], &current) && current.state != 'Z') active++;
  }
  return active;
}

static void reap_children(void)
{
  pid_t reaped;
  do {
    reaped = waitpid(-1, NULL, WNOHANG);
  } while (reaped > 0 || (reaped < 0 && errno == EINTR));
}

static bool stop_process_tree(pid_t worker, process_tracker *tracker)
{
  struct timespec now;
  clock_gettime(CLOCK_MONOTONIC, &now);
  const uint64_t end = ((uint64_t)now.tv_sec * 1000000000ULL) + now.tv_nsec + 5000000000ULL;
  int empty_scans = 0;
  do {
    if (collect_process_tree(tracker, worker) < 0) return false;
    if (signal_tracked_processes(tracker, worker, SIGKILL) < 0) return false;
    siginfo_t info = {0};
    int waited;
    do {
      waited = waitid(P_PID, (id_t)worker, &info, WEXITED | WNOHANG | WNOWAIT);
    } while (waited < 0 && errno == EINTR);
    if (waited < 0) return false;
    int active = active_process_count(tracker, worker);
    if (active < 0) return false;
    empty_scans = active == 0 ? empty_scans + 1 : 0;
    if (empty_scans >= 2 && info.si_pid == worker) {
      pid_t reaped;
      do {
        reaped = waitpid(worker, NULL, 0);
      } while (reaped < 0 && errno == EINTR);
      reap_children();
      return reaped == worker;
    }
    poll(NULL, 0, 20);
    clock_gettime(CLOCK_MONOTONIC, &now);
  } while (((uint64_t)now.tv_sec * 1000000000ULL) + now.tv_nsec < end);
  errno = ETIMEDOUT;
  return false;
}

static bool force_owner(void)
{
  int flag = openat(status_dir, "cancel.flag", O_RDONLY | O_CLOEXEC);
  if (flag < 0) return false;
  char json[512];
  ssize_t length = read(flag, json, sizeof json - 1);
  close(flag);
  if (length <= 0) return false;
  json[length] = '\0';
  const char *value = strstr(json, "\"terminateOwner\"");
  if (!value) return false;
  value += strlen("\"terminateOwner\"");
  while (isspace((unsigned char)*value)) value++;
  if (*value++ != ':') return false;
  while (isspace((unsigned char)*value)) value++;
  return strncmp(value, "true", 4) == 0;
}

static bool owner_alive(void)
{
  process_info owner = {0};
  int known = read_process(supervising_owner, &owner);
  if (known > 0) return owner.state != 'Z';
  if (known < 0 && errno == EPERM) return true;
  return false;
}

int main(int argc, char *argv[])
{
  if (argc < 4) return 70;
  char *end;
  long owner = strtol(argv[1], &end, 10);
  if (*end || owner <= 0 || owner > INT_MAX) return 70;
  supervising_owner = (pid_t)owner;
  status_dir = open(argv[2], O_RDONLY | O_DIRECTORY | O_CLOEXEC);
  if (status_dir < 0) {
    perror("open supervisor status directory");
    return 70;
  }
  if (prctl(PR_SET_CHILD_SUBREAPER, 1) < 0) {
    perror("enable child subreaper");
    return 70;
  }
  if (prctl(PR_SET_PDEATHSIG, SIGTERM) < 0 || getppid() != owner) {
    return publish_stop(0, "controller_closed", -1);
  }

  struct sigaction termination = {0};
  termination.sa_handler = request_termination;
  sigemptyset(&termination.sa_mask);
  if (sigaction(SIGTERM, &termination, NULL) < 0
    || sigaction(SIGINT, &termination, NULL) < 0
    || sigaction(SIGHUP, &termination, NULL) < 0) {
    perror("install supervisor signal handlers");
    return 70;
  }
  const bool proxy_stdio = environment_enabled("QUOTAFLOW_GUARD_PROXY_STDIO");
  struct pollfd controller = { .fd = STDIN_FILENO, .events = POLLIN };
  if (!proxy_stdio && poll(&controller, 1, 0) > 0) {
    return publish_stop(0, "controller_closed", -1);
  }

  pid_t worker = 0;
  int error = launch_worker(&argv[3], &worker, proxy_stdio);
  if (error) {
    fprintf(stderr, "Could not launch supervised command: %s\n", strerror(error));
    return publish_stop(0, "spawn_failed", 127);
  }
  process_tracker tracker = {0};
  char ready_json[96];
  snprintf(ready_json, sizeof ready_json, "{\"supervisorPid\":%d,\"workerPid\":%d}", getpid(), worker);
  bool ready = publish("ready.json", ready_json);
  const char *reason = ready ? "controller_closed" : "supervisor_error";
  int exit_code = ready ? -1 : 70;
  bool cancelled = false;
  while (ready && getppid() == owner) {
    if (collect_process_tree(&tracker, worker) < 0) {
      reason = "supervisor_error";
      exit_code = 70;
      break;
    }
    if (termination_signal) {
      reason = owner_alive() ? "supervisor_signal" : "controller_closed";
      exit_code = 128 + termination_signal;
      break;
    }
    if (faccessat(status_dir, "cancel.flag", F_OK, 0) == 0) {
      reason = "cancelled";
      cancelled = true;
      break;
    }
    siginfo_t info = {0};
    int waited;
    do {
      waited = waitid(P_PID, (id_t)worker, &info, WEXITED | WNOHANG | WNOWAIT);
    } while (waited < 0 && errno == EINTR);
    if (waited < 0) {
      reason = "supervisor_error";
      exit_code = 70;
      break;
    }
    if (info.si_pid == worker) {
      reason = "worker_exit";
      exit_code = info.si_code == CLD_EXITED ? info.si_status : 128 + info.si_status;
      break;
    }
    if (!proxy_stdio && poll(&controller, 1, 0) > 0) break;
    poll(NULL, 0, 25);
  }
  if (getppid() != owner && !cancelled && strcmp(reason, "worker_exit") != 0) reason = "controller_closed";
  if (!stop_process_tree(worker, &tracker)) {
    perror("could not verify the supervised process tree stopped");
    return 70;
  }
  if (cancelled && force_owner() && getppid() == owner && kill((pid_t)owner, SIGKILL) < 0 && errno != ESRCH) {
    perror("could not terminate the QuotaFlow owner");
  }
  return publish_stop(worker, reason, exit_code);
}
