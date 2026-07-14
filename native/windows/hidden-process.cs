using System;
using System.ComponentModel;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading.Tasks;
using Microsoft.Win32.SafeHandles;

internal static class HiddenProcessLauncher
{
    private const uint CreateNoWindow = 0x08000000;
    private const uint CreateUnicodeEnvironment = 0x00000400;
    private const uint StartfUseShowWindow = 0x00000001;
    private const uint StartfUseStdHandles = 0x00000100;
    private const ushort SwHide = 0;
    private const uint HandleFlagInherit = 0x00000001;
    private const uint GenericRead = 0x80000000;
    private const uint FileShareRead = 0x00000001;
    private const uint FileShareWrite = 0x00000002;
    private const uint OpenExisting = 3;
    private const uint FileAttributeNormal = 0x00000080;
    private const uint Infinite = 0xffffffff;
    private const uint WaitFailed = 0xffffffff;
    private static readonly IntPtr InvalidHandleValue = new IntPtr(-1);
    private static readonly Encoding Utf8 = new UTF8Encoding(false);

    [STAThread]
    private static int Main(string[] args)
    {
        if (args.Length < 1)
        {
            WriteStandardError(Utf8.GetBytes("Usage: hidden-process.exe <program> [arguments...]\n"));
            return 64;
        }

        try
        {
            return RunChild(args);
        }
        catch (Exception error)
        {
            WriteStandardError(Utf8.GetBytes(error + Environment.NewLine));
            return 1;
        }
    }

    private static int RunChild(string[] args)
    {
        IntPtr standardOutputRead = IntPtr.Zero;
        IntPtr standardOutputWrite = IntPtr.Zero;
        IntPtr standardErrorRead = IntPtr.Zero;
        IntPtr standardErrorWrite = IntPtr.Zero;
        IntPtr standardInput = IntPtr.Zero;
        ProcessInformation processInformation = new ProcessInformation();

        try
        {
            SecurityAttributes securityAttributes = new SecurityAttributes
            {
                Length = Marshal.SizeOf(typeof(SecurityAttributes)),
                InheritHandle = true,
            };

            CreateOutputPipe(
                ref securityAttributes,
                "standard output",
                out standardOutputRead,
                out standardOutputWrite
            );
            CreateOutputPipe(
                ref securityAttributes,
                "standard error",
                out standardErrorRead,
                out standardErrorWrite
            );

            standardInput = CreateFileW(
                "NUL",
                GenericRead,
                FileShareRead | FileShareWrite,
                ref securityAttributes,
                OpenExisting,
                FileAttributeNormal,
                IntPtr.Zero
            );
            if (standardInput == InvalidHandleValue)
            {
                standardInput = IntPtr.Zero;
                ThrowLastWin32Error("Failed to open NUL for standard input.");
            }

            StartupInfo startupInfo = new StartupInfo
            {
                Size = Marshal.SizeOf(typeof(StartupInfo)),
                Flags = StartfUseShowWindow | StartfUseStdHandles,
                ShowWindow = SwHide,
                StandardInput = standardInput,
                StandardOutput = standardOutputWrite,
                StandardError = standardErrorWrite,
            };
            string applicationPath = ResolveApplicationPath(args[0]);
            StringBuilder commandLine = new StringBuilder(BuildCommandLine(applicationPath, args));

            bool started = CreateProcessW(
                applicationPath,
                commandLine,
                IntPtr.Zero,
                IntPtr.Zero,
                true,
                CreateNoWindow | CreateUnicodeEnvironment,
                IntPtr.Zero,
                null,
                ref startupInfo,
                out processInformation
            );
            if (!started)
            {
                ThrowLastWin32Error("Failed to start the child process.");
            }

            CloseOwnedHandle(ref processInformation.Thread);
            CloseOwnedHandle(ref standardInput);
            CloseOwnedHandle(ref standardOutputWrite);
            CloseOwnedHandle(ref standardErrorWrite);

            IntPtr outputReadHandle = standardOutputRead;
            Task<byte[]> standardOutputTask = Task.Factory.StartNew(
                () => ReadAllBytes(outputReadHandle)
            );
            standardOutputRead = IntPtr.Zero;

            IntPtr errorReadHandle = standardErrorRead;
            Task<byte[]> standardErrorTask = Task.Factory.StartNew(
                () => ReadAllBytes(errorReadHandle)
            );
            standardErrorRead = IntPtr.Zero;

            if (WaitForSingleObject(processInformation.Process, Infinite) == WaitFailed)
            {
                ThrowLastWin32Error("Failed while waiting for the child process.");
            }

            Task.WaitAll(standardOutputTask, standardErrorTask);
            uint exitCode;
            if (!GetExitCodeProcess(processInformation.Process, out exitCode))
            {
                ThrowLastWin32Error("Failed to read the child process exit code.");
            }

            WriteStandardOutput(standardOutputTask.Result);
            WriteStandardError(standardErrorTask.Result);
            return unchecked((int)exitCode);
        }
        finally
        {
            CloseOwnedHandle(ref standardOutputRead);
            CloseOwnedHandle(ref standardOutputWrite);
            CloseOwnedHandle(ref standardErrorRead);
            CloseOwnedHandle(ref standardErrorWrite);
            CloseOwnedHandle(ref standardInput);
            CloseOwnedHandle(ref processInformation.Thread);
            CloseOwnedHandle(ref processInformation.Process);
        }
    }

    private static void CreateOutputPipe(
        ref SecurityAttributes securityAttributes,
        string description,
        out IntPtr readHandle,
        out IntPtr writeHandle
    )
    {
        if (!CreatePipe(out readHandle, out writeHandle, ref securityAttributes, 0))
        {
            ThrowLastWin32Error("Failed to create the " + description + " pipe.");
        }

        if (!SetHandleInformation(readHandle, HandleFlagInherit, 0))
        {
            CloseOwnedHandle(ref readHandle);
            CloseOwnedHandle(ref writeHandle);
            ThrowLastWin32Error("Failed to protect the " + description + " read handle.");
        }
    }

    private static byte[] ReadAllBytes(IntPtr handle)
    {
        using (SafeFileHandle safeHandle = new SafeFileHandle(handle, true))
        using (FileStream stream = new FileStream(safeHandle, FileAccess.Read, 4096, false))
        using (MemoryStream buffer = new MemoryStream())
        {
            stream.CopyTo(buffer);
            return buffer.ToArray();
        }
    }

    private static string ResolveApplicationPath(string value)
    {
        if (Path.IsPathRooted(value) || value.IndexOf('\\') >= 0 || value.IndexOf('/') >= 0)
        {
            return Path.GetFullPath(value);
        }

        StringBuilder result = new StringBuilder(32768);
        IntPtr filePart;
        string extension = Path.HasExtension(value) ? null : ".exe";
        uint length = SearchPathW(
            null,
            value,
            extension,
            (uint)result.Capacity,
            result,
            out filePart
        );
        if (length == 0)
        {
            ThrowLastWin32Error("Failed to resolve the child executable path.");
        }

        if (length >= result.Capacity)
        {
            result.Capacity = checked((int)length + 1);
            length = SearchPathW(
                null,
                value,
                extension,
                (uint)result.Capacity,
                result,
                out filePart
            );
            if (length == 0 || length >= result.Capacity)
            {
                ThrowLastWin32Error("Failed to resolve the complete child executable path.");
            }
        }

        return result.ToString();
    }

    private static string BuildCommandLine(string applicationPath, string[] args)
    {
        StringBuilder result = new StringBuilder();
        result.Append(QuoteArgument(applicationPath));
        for (int index = 1; index < args.Length; index += 1)
        {
            result.Append(' ');
            result.Append(QuoteArgument(args[index]));
        }

        return result.ToString();
    }

    private static string QuoteArgument(string value)
    {
        if (value.Length == 0)
        {
            return "\"\"";
        }

        if (value.IndexOfAny(new[] { ' ', '\t', '\n', '\v', '"' }) < 0)
        {
            return value;
        }

        StringBuilder result = new StringBuilder();
        result.Append('"');
        int backslashCount = 0;

        foreach (char character in value)
        {
            if (character == '\\')
            {
                backslashCount += 1;
                continue;
            }

            if (character == '"')
            {
                result.Append('\\', backslashCount * 2 + 1);
                result.Append('"');
                backslashCount = 0;
                continue;
            }

            result.Append('\\', backslashCount);
            backslashCount = 0;
            result.Append(character);
        }

        result.Append('\\', backslashCount * 2);
        result.Append('"');
        return result.ToString();
    }

    private static void WriteStandardOutput(byte[] bytes)
    {
        WriteBytes(Console.OpenStandardOutput(), bytes);
    }

    private static void WriteStandardError(byte[] bytes)
    {
        WriteBytes(Console.OpenStandardError(), bytes);
    }

    private static void WriteBytes(Stream stream, byte[] bytes)
    {
        if (bytes == null || bytes.Length == 0)
        {
            return;
        }

        stream.Write(bytes, 0, bytes.Length);
        stream.Flush();
    }

    private static void CloseOwnedHandle(ref IntPtr handle)
    {
        if (handle == IntPtr.Zero || handle == InvalidHandleValue)
        {
            handle = IntPtr.Zero;
            return;
        }

        CloseHandle(handle);
        handle = IntPtr.Zero;
    }

    private static void ThrowLastWin32Error(string message)
    {
        throw new Win32Exception(Marshal.GetLastWin32Error(), message);
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct SecurityAttributes
    {
        public int Length;
        public IntPtr SecurityDescriptor;

        [MarshalAs(UnmanagedType.Bool)]
        public bool InheritHandle;
    }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct StartupInfo
    {
        public int Size;
        public string Reserved;
        public string Desktop;
        public string Title;
        public int X;
        public int Y;
        public int XSize;
        public int YSize;
        public int XCountChars;
        public int YCountChars;
        public int FillAttribute;
        public uint Flags;
        public ushort ShowWindow;
        public ushort ReservedByteCount;
        public IntPtr ReservedBytes;
        public IntPtr StandardInput;
        public IntPtr StandardOutput;
        public IntPtr StandardError;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct ProcessInformation
    {
        public IntPtr Process;
        public IntPtr Thread;
        public int ProcessId;
        public int ThreadId;
    }

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool CreatePipe(
        out IntPtr readPipe,
        out IntPtr writePipe,
        ref SecurityAttributes pipeAttributes,
        uint size
    );

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool SetHandleInformation(
        IntPtr handle,
        uint mask,
        uint flags
    );

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern IntPtr CreateFileW(
        string fileName,
        uint desiredAccess,
        uint shareMode,
        ref SecurityAttributes securityAttributes,
        uint creationDisposition,
        uint flagsAndAttributes,
        IntPtr templateFile
    );

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern uint SearchPathW(
        string path,
        string fileName,
        string extension,
        uint bufferLength,
        StringBuilder buffer,
        out IntPtr filePart
    );

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool CreateProcessW(
        string applicationName,
        StringBuilder commandLine,
        IntPtr processAttributes,
        IntPtr threadAttributes,
        [MarshalAs(UnmanagedType.Bool)] bool inheritHandles,
        uint creationFlags,
        IntPtr environment,
        string currentDirectory,
        ref StartupInfo startupInfo,
        out ProcessInformation processInformation
    );

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool GetExitCodeProcess(IntPtr process, out uint exitCode);

    [DllImport("kernel32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool CloseHandle(IntPtr handle);
}
