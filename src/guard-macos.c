#define _DARWIN_C_SOURCE
#include <ctype.h>
#include <errno.h>
#include <fcntl.h>
#include <libproc.h>
#include <limits.h>
#include <poll.h>
#include <signal.h>
#include <spawn.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/proc.h>
#include <sys/proc_info.h>
#include <sys/wait.h>
#include <time.h>
#include <unistd.h>

extern char **environ;
static int status_dir;
static volatile sig_atomic_t termination_signal;
static pid_t supervising_owner;

#define MAX_TRACKED_PROCESSES 4096

typedef struct tracked_process {
  pid_t pid;
  pid_t pgid;
  uint64_t start_seconds;
  uint64_t start_microseconds;
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
  posix_spawnattr_t attr;
  int error = posix_spawnattr_init(&attr);
  if (error) return error;
  posix_spawn_file_actions_t actions;
  error = posix_spawn_file_actions_init(&actions);
  if (!error) {
    int log = openat(status_dir, "worker.log", O_WRONLY | O_CREAT | O_TRUNC | O_CLOEXEC, 0600);
    if (log < 0) error = errno;
    // The session isolates the initial process group from other jobs on the host.
    if (!error) error = posix_spawnattr_setflags(&attr, POSIX_SPAWN_SETSID | POSIX_SPAWN_CLOEXEC_DEFAULT);
    if (!error && proxy_stdio) {
      error = posix_spawn_file_actions_adddup2(&actions, STDIN_FILENO, STDIN_FILENO);
      if (!error) error = posix_spawn_file_actions_adddup2(&actions, STDOUT_FILENO, STDOUT_FILENO);
      if (!error) error = posix_spawn_file_actions_adddup2(&actions, log, STDERR_FILENO);
    } else if (!error) {
      error = posix_spawn_file_actions_addopen(&actions, STDIN_FILENO, "/dev/null", O_RDONLY, 0);
      if (!error) error = posix_spawn_file_actions_adddup2(&actions, log, STDOUT_FILENO);
      if (!error) error = posix_spawn_file_actions_adddup2(&actions, log, STDERR_FILENO);
    }
    if (!error) error = posix_spawnp(worker, command[0], &actions, &attr, command, environ);
    if (log >= 0) close(log);
    posix_spawn_file_actions_destroy(&actions);
  }
  posix_spawnattr_destroy(&attr);
  return error;
}

static int read_exit(pid_t worker, siginfo_t *info)
{
  int result;
  do {
    result = waitid(P_PID, (id_t)worker, info, WEXITED | WNOHANG | WNOWAIT);
  } while (result < 0 && errno == EINTR);
  return result;
}

static int process_identity(pid_t pid, tracked_process *identity, bool *active)
{
  struct proc_bsdinfo info;
  errno = 0;
  const int bytes = proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, &info, sizeof info);
  if (bytes == 0 || (bytes < 0 && (errno == ESRCH || errno == ENOENT))) {
    *active = false;
    return 0;
  }
  if (bytes < 0) return -1;
  if (bytes != sizeof info) {
    errno = EIO;
    return -1;
  }
  identity->pid = pid;
  identity->pgid = (pid_t)info.pbi_pgid;
  identity->start_seconds = info.pbi_start_tvsec;
  identity->start_microseconds = info.pbi_start_tvusec;
  *active = info.pbi_status != SZOMB;
  return 1;
}

static bool same_process(const tracked_process *left, const tracked_process *right)
{
  return left->pid == right->pid
    && left->start_seconds == right->start_seconds
    && left->start_microseconds == right->start_microseconds;
}

static int track_process(process_tracker *tracker, pid_t pid)
{
  if (pid <= 1 || pid == getpid() || pid == supervising_owner) return 0;
  tracked_process current;
  bool active = false;
  const int known = process_identity(pid, &current, &active);
  if (known <= 0 || !active) return known;
  for (size_t index = 0; index < tracker->count; index++) {
    if (tracker->entries[index].pid != pid) continue;
    tracker->entries[index] = current;
    return 0;
  }
  if (tracker->count == MAX_TRACKED_PROCESSES) {
    errno = EOVERFLOW;
    return -1;
  }
  tracker->entries[tracker->count++] = current;
  return 1;
}

static int track_pid_list(process_tracker *tracker, pid_t owner, bool process_group)
{
  pid_t pids[MAX_TRACKED_PROCESSES];
  errno = 0;
  const int count = process_group
    ? proc_listpgrppids(owner, pids, sizeof pids)
    : proc_listchildpids(owner, pids, sizeof pids);
  if (count < 0) {
    if (errno == ESRCH || errno == ENOENT) return 0;
    return -1;
  }
  if (count >= MAX_TRACKED_PROCESSES) {
    errno = EOVERFLOW;
    return -1;
  }
  for (int index = 0; index < count; index++) {
    const int tracked = track_process(tracker, pids[index]);
    if (tracked < 0) {
      return -1;
    }
  }
  return 0;
}

static int track_tree(process_tracker *tracker)
{
  size_t cursor = 0;
  while (cursor < tracker->count) {
    const tracked_process expected = tracker->entries[cursor++];
    tracked_process current;
    bool active = false;
    const int known = process_identity(expected.pid, &current, &active);
    if (known < 0) return -1;
    if (known == 0 || !active || !same_process(&expected, &current)) continue;
    tracker->entries[cursor - 1] = current;
    if (track_pid_list(tracker, current.pid, false) < 0) return -1;
    if (current.pgid != getpgrp() && track_pid_list(tracker, current.pgid, true) < 0) return -1;
  }
  return 0;
}

static int current_identity_status(const tracked_process *record, bool *active)
{
  tracked_process current;
  const int known = process_identity(record->pid, &current, active);
  if (known <= 0) return known;
  if (!same_process(record, &current)) *active = false;
  return 1;
}

static int signal_tracked_processes(process_tracker *tracker, pid_t worker, int signal_number)
{
  if (kill(-worker, signal_number) < 0 && errno != ESRCH && errno != EPERM) return -1;
  const pid_t own_group = getpgrp();
  for (size_t index = 0; index < tracker->count; index++) {
    bool active = false;
    const int known = current_identity_status(&tracker->entries[index], &active);
    if (known < 0) return -1;
    if (known == 0 || !active) continue;
    if (kill(tracker->entries[index].pid, signal_number) < 0 && errno != ESRCH && errno != EPERM) return -1;
    const pid_t group = tracker->entries[index].pgid;
    if (group > 1 && group != own_group
      && kill(-group, signal_number) < 0 && errno != ESRCH && errno != EPERM) return -1;
  }
  return 0;
}

static int active_process_count(process_tracker *tracker)
{
  if (track_tree(tracker) < 0) return -1;
  int active_count = 0;
  for (size_t index = 0; index < tracker->count; index++) {
    bool active = false;
    const int known = current_identity_status(&tracker->entries[index], &active);
    if (known < 0) return -1;
    if (known > 0 && active) active_count++;
  }
  return active_count;
}

static bool stop_process_tree(pid_t worker, process_tracker *tracker)
{
  const uint64_t deadline = clock_gettime_nsec_np(CLOCK_MONOTONIC) + 5000000000ULL;
  do {
    if (track_tree(tracker) < 0) return false;
    if (signal_tracked_processes(tracker, worker, SIGKILL) < 0) return false;
    siginfo_t info = {0};
    if (read_exit(worker, &info) < 0) return false;
    const int active = active_process_count(tracker);
    if (active < 0) return false;
    if (active == 0 && info.si_pid == worker) {
      pid_t reaped;
      do {
        reaped = waitpid(worker, NULL, 0);
      } while (reaped < 0 && errno == EINTR);
      return reaped == worker;
    }
    poll(NULL, 0, 20);
  } while (clock_gettime_nsec_np(CLOCK_MONOTONIC) < deadline);
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

int main(int argc, char *argv[])
{
  if (argc < 4) return 70;
  char *end;
  long owner = strtol(argv[1], &end, 10);
  if (*end || owner <= 1 || owner > INT_MAX) return 70;
  supervising_owner = (pid_t)owner;
  status_dir = open(argv[2], O_RDONLY | O_DIRECTORY | O_CLOEXEC);
  if (status_dir < 0) {
    perror("open supervisor status directory");
    return 70;
  }
  const bool proxy_stdio = environment_enabled("QUOTAFLOW_GUARD_PROXY_STDIO");
  struct pollfd controller = { .fd = STDIN_FILENO, .events = POLLIN };
  if (getppid() != owner || (!proxy_stdio && poll(&controller, 1, 0) > 0)) {
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

  pid_t worker = 0;
  int error = launch_worker(&argv[3], &worker, proxy_stdio);
  if (error) {
    fprintf(stderr, "Could not launch supervised command: %s\n", strerror(error));
    return publish_stop(0, "spawn_failed", 127);
  }
  process_tracker tracker = {0};
  if (track_process(&tracker, worker) < 0) {
    perror("could not track the supervised process");
    return 70;
  }

  char json[96];
  snprintf(json, sizeof json, "{\"supervisorPid\":%d,\"workerPid\":%d}", getpid(), worker);
  bool ready = publish("ready.json", json);
  const char *reason = ready ? "controller_closed" : "supervisor_error";
  int exit_code = ready ? -1 : 70;
  bool cancelled = false;
  while (ready && getppid() == owner) {
    if (track_tree(&tracker) < 0) {
      reason = "supervisor_error";
      exit_code = 70;
      break;
    }
    if (termination_signal) {
      reason = "supervisor_signal";
      exit_code = 128 + termination_signal;
      break;
    }
    if (faccessat(status_dir, "cancel.flag", F_OK, 0) == 0) {
      reason = "cancelled";
      cancelled = true;
      break;
    }
    siginfo_t info = {0};
    if (read_exit(worker, &info) < 0) {
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

  if (!stop_process_tree(worker, &tracker)) {
    perror("could not verify the supervised process tree stopped");
    return 70;
  }
  if (cancelled && force_owner() && getppid() == owner && kill((pid_t)owner, SIGKILL) < 0 && errno != ESRCH) {
    perror("could not terminate the QuotaFlow owner");
  }
  return publish_stop(worker, reason, exit_code);
}
