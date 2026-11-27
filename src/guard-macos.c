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
#include <sys/wait.h>
#include <time.h>
#include <unistd.h>

extern char **environ;
static int status_dir;

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

static int launch_worker(char *const command[], pid_t *worker)
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
    if (!error) error = posix_spawn_file_actions_addopen(&actions, STDIN_FILENO, "/dev/null", O_RDONLY, 0);
    if (!error) error = posix_spawn_file_actions_adddup2(&actions, log, STDOUT_FILENO);
    if (!error) error = posix_spawn_file_actions_adddup2(&actions, log, STDERR_FILENO);
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

static bool stop_group(pid_t worker)
{
  const uint64_t deadline = clock_gettime_nsec_np(CLOCK_MONOTONIC) + 5000000000ULL;
  do {
    siginfo_t info = {0};
    if (read_exit(worker, &info) < 0) return false;
    // EPERM can mean only zombies remain. The kernel process list must still verify emptiness.
    if (kill(-worker, SIGKILL) < 0 && errno != ESRCH && errno != EPERM) return false;
    if (info.si_pid == worker) {
      // Keep the exited leader unreaped to pin the PID while enumerating and signalling its group.
      pid_t members[2];
      errno = 0;
      const int count = proc_listpgrppids(worker, members, sizeof members);
      if (count < 0 || (count == 0 && errno != 0)) return false;
      if (count == 0 || (count == 1 && members[0] == worker)) {
        pid_t reaped;
        do {
          reaped = waitpid(worker, NULL, 0);
        } while (reaped < 0 && errno == EINTR);
        return reaped == worker;
      }
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
  status_dir = open(argv[2], O_RDONLY | O_DIRECTORY | O_CLOEXEC);
  if (status_dir < 0) {
    perror("open supervisor status directory");
    return 70;
  }
  struct pollfd controller = { .fd = STDIN_FILENO, .events = POLLIN };
  if (getppid() != owner || poll(&controller, 1, 0) > 0) {
    return publish_stop(0, "controller_closed", -1);
  }

  pid_t worker = 0;
  int error = launch_worker(&argv[3], &worker);
  if (error) {
    fprintf(stderr, "Could not launch supervised command: %s\n", strerror(error));
    return publish_stop(0, "spawn_failed", 127);
  }

  char json[96];
  snprintf(json, sizeof json, "{\"supervisorPid\":%d,\"workerPid\":%d}", getpid(), worker);
  bool ready = publish("ready.json", json);
  const char *reason = ready ? "controller_closed" : "supervisor_error";
  int exit_code = ready ? -1 : 70;
  bool cancelled = false;
  while (ready && getppid() == owner) {
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
    if (poll(&controller, 1, 25) > 0) break;
  }

  if (!stop_group(worker)) {
    perror("could not verify the supervised process group stopped");
    return 70;
  }
  if (cancelled && force_owner() && getppid() == owner && kill((pid_t)owner, SIGKILL) < 0 && errno != ESRCH) {
    perror("could not terminate the QuotaFlow owner");
  }
  return publish_stop(worker, reason, exit_code);
}
