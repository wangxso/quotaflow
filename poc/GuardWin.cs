using System;
using System.ComponentModel;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Threading.Tasks;

public static class QuotaFlowGuard
{
    private const uint KillOnClose = 0x2000;
    private const uint CreateSuspended = 0x4;
    private const uint CreateNoWindow = 0x08000000;
    private const uint WaitObject = 0;
    private const uint WaitTimeout = 258;
    private const int BasicAccounting = 1;
    private const int ExtendedLimit = 9;

    public static void Run(string exe, string[] args, string cwd, string status, uint ownerPid, long createdBy, string name)
    {
        var supervisor = Process.GetCurrentProcess().Id;
        var parent = Task.Factory.StartNew(() => Console.OpenStandardInput().ReadByte());
        var job = CreateJobObject(IntPtr.Zero, name);
        if (job == IntPtr.Zero) throw new Win32Exception();
        if (Marshal.GetLastWin32Error() == 183)
        {
            CloseHandle(job);
            throw new InvalidOperationException("Job name is already in use");
        }
        IntPtr owner = IntPtr.Zero;

        ProcessInfo worker = new ProcessInfo();
        IntPtr input = IntPtr.Zero;
        IntPtr log = IntPtr.Zero;
        bool assigned = false;
        try
        {
            Limits limits = new Limits();
            limits.Basic.Flags = KillOnClose;
            Require(SetInformationJobObject(job, ExtendedLimit, ref limits, Marshal.SizeOf(typeof(Limits))));
            owner = OpenProcess(0x101000, false, ownerPid);
            long creation, exit, kernel, user;
            if (owner == IntPtr.Zero || !GetProcessTimes(owner, out creation, out exit, out kernel, out user) ||
                new DateTimeOffset(DateTime.FromFileTimeUtc(creation)).ToUnixTimeMilliseconds() > createdBy ||
                ControllerStopped(owner, parent))
            {
                WriteStopped(status, supervisor, 0, null, "controller_closed");
                return;
            }
            Startup startup = new Startup();
            startup.Size = Marshal.SizeOf(typeof(Startup));
            var security = new Security { Length = Marshal.SizeOf(typeof(Security)), Inherit = true };
            input = CreateFile("NUL", 0x80000000, 3, ref security, 3, 0x80, IntPtr.Zero);
            log = CreateFile(Path.Combine(status, "worker.log"), 0x40000000, 1, ref security, 2, 0x80, IntPtr.Zero);
            if (input.ToInt64() == -1 || log.ToInt64() == -1) throw new Win32Exception();
            startup.Flags = 0x100;
            startup.StandardIn = input;
            startup.StandardOut = log;
            startup.StandardError = log;
            var command = new StringBuilder(string.Join(" ", new[] { exe }.Concat(args).Select(Quote)));
            Require(CreateProcess(exe, command, IntPtr.Zero, IntPtr.Zero, true,
                CreateSuspended | CreateNoWindow, IntPtr.Zero, cwd, ref startup, out worker));
            Require(AssignProcessToJobObject(job, worker.Process));
            assigned = true;
            if (ResumeThread(worker.Thread) == UInt32.MaxValue) throw new Win32Exception();
            Publish(status, "ready.json", String.Format(CultureInfo.InvariantCulture,
                "{{\"supervisorPid\":{0},\"workerPid\":{1},\"session\":{2},\"job\":\"{3}\"}}",
                supervisor, worker.ProcessId, Process.GetCurrentProcess().SessionId, name));

            uint? exitCode = null;
            while (!ControllerStopped(owner, parent))
            {
                uint wait = WaitForSingleObject(worker.Process, 30);
                if (wait == WaitObject)
                {
                    uint code;
                    Require(GetExitCodeProcess(worker.Process, out code));
                    exitCode = code;
                    break;
                }
                if (wait != WaitTimeout) throw new Win32Exception();
            }

            if (Active(job) > 0) Require(TerminateJobObject(job, 72));
            var deadline = Stopwatch.StartNew();
            while (Active(job) > 0)
            {
                if (deadline.ElapsedMilliseconds > 5000) throw new TimeoutException("Job processes still active");
                Thread.Sleep(20);
            }
            WriteStopped(status, supervisor, worker.ProcessId, exitCode, exitCode.HasValue ? "worker_exit" : "controller_closed");
        }
        finally
        {
            if (!assigned && worker.Process != IntPtr.Zero) TerminateProcess(worker.Process, 70);
            if (worker.Thread != IntPtr.Zero) CloseHandle(worker.Thread);
            if (worker.Process != IntPtr.Zero) CloseHandle(worker.Process);
            if (input.ToInt64() > 0) CloseHandle(input);
            if (log.ToInt64() > 0) CloseHandle(log);
            if (owner != IntPtr.Zero) CloseHandle(owner);
            CloseHandle(job);
        }
    }

    private static bool ControllerStopped(IntPtr owner, Task<int> input)
    {
        return input.IsCompleted || WaitForSingleObject(owner, 0) != WaitTimeout;
    }

    public static void VerifyStopped(string dir, string name, int session, int supervisor, uint worker)
    {
        if (!Regex.IsMatch(name, "^QuotaFlow-Phase0-[a-f0-9-]{36}$") || Process.GetCurrentProcess().SessionId != session)
            throw new InvalidOperationException("Cannot verify the job identity in this Windows session");

        IntPtr job = OpenJobObject(4, false, name);
        if (job == IntPtr.Zero)
        {
            int error = Marshal.GetLastWin32Error();
            if (error != 2) throw new Win32Exception(error);
        }
        else
        {
            try { if (Active(job) != 0) return; }
            finally { CloseHandle(job); }
        }
        if (!File.Exists(Path.Combine(dir, "stopped.json"))) WriteStopped(dir, supervisor, worker, null, "job_reaped");
    }

    private static void WriteStopped(string dir, int supervisor, uint worker, uint? exitCode, string reason)
    {
        Publish(dir, "stopped.json", String.Format(CultureInfo.InvariantCulture,
            "{{\"supervisorPid\":{0},\"workerPid\":{1},\"exitCode\":{2},\"activeProcesses\":0,\"reason\":\"{3}\"}}",
            supervisor, worker, exitCode.HasValue ? exitCode.Value.ToString(CultureInfo.InvariantCulture) : "null", reason));
    }

    private static void Publish(string dir, string file, string value)
    {
        string path = Path.Combine(dir, file);
        var pending = path + "." + Process.GetCurrentProcess().Id + ".pending";
        File.WriteAllText(pending, value);
        try { File.Move(pending, path); }
        catch (IOException)
        {
            File.Delete(pending);
            if (!File.Exists(path)) throw;
        }
    }

    private static uint Active(IntPtr job)
    {
        Accounting snapshot;
        Require(QueryInformationJobObject(job, BasicAccounting, out snapshot, Marshal.SizeOf(typeof(Accounting)), IntPtr.Zero));
        return snapshot.ActiveProcesses;
    }

    private static string Quote(string arg)
    {
        string quoted = Regex.Replace(arg, "(\\\\*)\"", "$1$1\\\"");
        return "\"" + Regex.Replace(quoted, "(\\\\+)$", "$1$1") + "\"";
    }

    private static void Require(bool success) { if (!success) throw new Win32Exception(); }

    [StructLayout(LayoutKind.Sequential)]
    private struct BasicLimits
    {
        public long ProcessTime, JobTime;
        public uint Flags;
        public UIntPtr MinWorkingSet, MaxWorkingSet;
        public uint ProcessLimit;
        public UIntPtr Affinity;
        public uint PriorityClass, SchedulingClass;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct Limits
    {
        public BasicLimits Basic;
        public ulong ReadOperations, WriteOperations, OtherOperations, ReadBytes, WriteBytes, OtherBytes;
        public UIntPtr ProcessMemory, JobMemory, PeakProcessMemory, PeakJobMemory;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct Accounting
    {
        public long UserTime, KernelTime, PeriodUserTime, PeriodKernelTime;
        public uint PageFaults, Processes, ActiveProcesses, Terminated;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct Startup
    {
        public int Size;
        public IntPtr Reserved, Desktop, Title;
        public uint X, Y, Width, Height, WidthChars, HeightChars, Fill, Flags;
        public ushort Show, ReservedSize;
        public IntPtr ReservedData, StandardIn, StandardOut, StandardError;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct ProcessInfo
    {
        public IntPtr Process, Thread;
        public uint ProcessId, ThreadId;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct Security
    {
        public int Length;
        public IntPtr Descriptor;
        public bool Inherit;
    }

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern IntPtr CreateJobObject(IntPtr attributes, string name);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern IntPtr OpenJobObject(uint access, bool inherit, string name);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool SetInformationJobObject(IntPtr job, int type, ref Limits data, int size);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool QueryInformationJobObject(IntPtr job, int type, out Accounting data, int size, IntPtr length);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool CreateProcess(string executable, StringBuilder command, IntPtr processAttributes,
        IntPtr threadAttributes, bool inherit, uint flags, IntPtr environment, string cwd, ref Startup startup, out ProcessInfo process);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern IntPtr CreateFile(string name, uint access, uint sharing, ref Security security,
        uint creation, uint flags, IntPtr template);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern uint ResumeThread(IntPtr thread);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool GetExitCodeProcess(IntPtr process, out uint exitCode);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern IntPtr OpenProcess(uint access, bool inherit, uint processId);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool GetProcessTimes(IntPtr handle, out long creation, out long exit, out long kernel, out long user);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool TerminateJobObject(IntPtr job, uint exitCode);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool TerminateProcess(IntPtr process, uint exitCode);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool CloseHandle(IntPtr handle);
}
