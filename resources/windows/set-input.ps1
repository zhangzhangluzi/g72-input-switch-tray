param(
    [string]$MonitorName,

    [ValidateRange(1, 255)]
    [int]$InputValue,

    [switch]$ListOnly
)

$ErrorActionPreference = "Stop"

if (-not $ListOnly) {
    if ([string]::IsNullOrWhiteSpace($MonitorName)) {
        throw "MonitorName was not provided."
    }

    if (-not $PSBoundParameters.ContainsKey("InputValue")) {
        throw "InputValue was not provided."
    }
}

Add-Type @"
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;

public static class NativeDisplayMapper
{
    public delegate bool MonitorEnumProc(IntPtr hMonitor, IntPtr hdc, ref RECT rect, IntPtr data);

    [StructLayout(LayoutKind.Sequential)]
    public struct RECT
    {
        public int Left;
        public int Top;
        public int Right;
        public int Bottom;
    }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Auto)]
    public struct MONITORINFOEX
    {
        public int cbSize;
        public RECT rcMonitor;
        public RECT rcWork;
        public uint dwFlags;

        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)]
        public string szDevice;
    }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Auto)]
    public struct DISPLAY_DEVICE
    {
        public int cb;

        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)]
        public string DeviceName;

        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 128)]
        public string DeviceString;

        public int StateFlags;

        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 128)]
        public string DeviceID;

        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 128)]
        public string DeviceKey;
    }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    public struct PHYSICAL_MONITOR
    {
        public IntPtr hPhysicalMonitor;

        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 128)]
        public string szPhysicalMonitorDescription;
    }

    public class LogicalMonitor
    {
        public IntPtr HMonitor;
        public string GdiDeviceName;
        public string DisplayDeviceId;
        public string DisplayProductCode;
    }

    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool EnumDisplayMonitors(
        IntPtr hdc,
        IntPtr clip,
        MonitorEnumProc callback,
        IntPtr data
    );

    [DllImport("user32.dll", CharSet = CharSet.Auto)]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool GetMonitorInfo(
        IntPtr hMonitor,
        ref MONITORINFOEX info
    );

    [DllImport("user32.dll", CharSet = CharSet.Auto)]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool EnumDisplayDevices(
        string device,
        uint deviceIndex,
        ref DISPLAY_DEVICE displayDevice,
        uint flags
    );

    [DllImport("dxva2.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool GetNumberOfPhysicalMonitorsFromHMONITOR(
        IntPtr hMonitor,
        out uint count
    );

    [DllImport("dxva2.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool GetPhysicalMonitorsFromHMONITOR(
        IntPtr hMonitor,
        uint count,
        [Out] PHYSICAL_MONITOR[] monitors
    );

    [DllImport("dxva2.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool DestroyPhysicalMonitors(
        uint count,
        [In] PHYSICAL_MONITOR[] monitors
    );

    [DllImport("dxva2.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool SetVCPFeature(
        IntPtr monitor,
        byte code,
        uint value
    );

    public static LogicalMonitor[] EnumerateLogicalMonitors()
    {
        var results = new List<LogicalMonitor>();

        MonitorEnumProc callback = delegate(IntPtr hMonitor, IntPtr hdc, ref RECT rect, IntPtr data)
        {
            var info = new MONITORINFOEX();
            info.cbSize = Marshal.SizeOf(typeof(MONITORINFOEX));

            if (!GetMonitorInfo(hMonitor, ref info))
            {
                return true;
            }

            var display = new DISPLAY_DEVICE();
            display.cb = Marshal.SizeOf(typeof(DISPLAY_DEVICE));
            if (!EnumDisplayDevices(info.szDevice, 0, ref display, 0))
            {
                return true;
            }

            var logicalMonitor = new LogicalMonitor();
            logicalMonitor.HMonitor = hMonitor;
            logicalMonitor.GdiDeviceName = info.szDevice;
            logicalMonitor.DisplayDeviceId = display.DeviceID ?? string.Empty;
            logicalMonitor.DisplayProductCode = ExtractProductCode(display.DeviceID);
            results.Add(logicalMonitor);
            return true;
        };

        if (!EnumDisplayMonitors(IntPtr.Zero, IntPtr.Zero, callback, IntPtr.Zero))
        {
            throw new InvalidOperationException("EnumDisplayMonitors failed.");
        }

        return results.ToArray();
    }

    public static PHYSICAL_MONITOR[] GetPhysicalMonitorsForDisplay(IntPtr hMonitor)
    {
        uint count;
        if (!GetNumberOfPhysicalMonitorsFromHMONITOR(hMonitor, out count) || count == 0)
        {
            return new PHYSICAL_MONITOR[0];
        }

        var monitors = new PHYSICAL_MONITOR[count];
        if (!GetPhysicalMonitorsFromHMONITOR(hMonitor, count, monitors))
        {
            return new PHYSICAL_MONITOR[0];
        }

        return monitors;
    }

    public static void ReleasePhysicalMonitors(PHYSICAL_MONITOR[] monitors)
    {
        if (monitors == null || monitors.Length == 0)
        {
            return;
        }

        DestroyPhysicalMonitors((uint)monitors.Length, monitors);
    }

    public static bool SetInput(PHYSICAL_MONITOR monitor, uint inputValue)
    {
        return SetVCPFeature(monitor.hPhysicalMonitor, 0x60, inputValue);
    }

    private static string ExtractProductCode(string deviceId)
    {
        if (string.IsNullOrEmpty(deviceId))
        {
            return string.Empty;
        }

        var parts = deviceId.Split('\\');
        if (parts.Length < 2)
        {
            return deviceId;
        }

        return parts[1];
    }
}
"@

function Get-FriendlyNameMap {
    $friendlyNameMap = @{}

    foreach ($monitor in Get-CimInstance -Namespace root\wmi -ClassName WmiMonitorID) {
        $friendlyName = ([System.Text.Encoding]::ASCII.GetString($monitor.UserFriendlyName) -replace "`0", "").Trim()
        if ([string]::IsNullOrWhiteSpace($friendlyName)) {
            continue
        }

        $segments = $monitor.InstanceName -split '\\'
        if ($segments.Length -lt 2) {
            continue
        }

        $friendlyNameMap[$segments[1].ToUpperInvariant()] = $friendlyName
    }

    return $friendlyNameMap
}

$friendlyNameMap = Get-FriendlyNameMap
$logicalMonitors = [NativeDisplayMapper]::EnumerateLogicalMonitors()
$availableMonitors = @()
$targetLogicalMonitor = $null

foreach ($logicalMonitor in $logicalMonitors) {
    $friendlyName = $null
    if ($friendlyNameMap.ContainsKey($logicalMonitor.DisplayProductCode.ToUpperInvariant())) {
        $friendlyName = $friendlyNameMap[$logicalMonitor.DisplayProductCode.ToUpperInvariant()]
    }

    $availableMonitors += if ([string]::IsNullOrWhiteSpace($friendlyName)) {
        $logicalMonitor.DisplayProductCode
    } else {
        $friendlyName
    }

    if ($friendlyName -eq $MonitorName) {
        $targetLogicalMonitor = $logicalMonitor
    }
}

if ($null -eq $targetLogicalMonitor) {
    $availableText = if ($availableMonitors.Count -gt 0) {
        $availableMonitors -join ", "
    } else {
        "<none>"
    }

    if ($ListOnly) {
        $uniqueMonitors = $availableMonitors | Sort-Object -Unique
        Write-Output ($uniqueMonitors | ConvertTo-Json -Compress)
        exit 0
    }

    throw "No monitor matched '$MonitorName'. Available monitors: $availableText"
}

$physicalMonitors = [NativeDisplayMapper]::GetPhysicalMonitorsForDisplay($targetLogicalMonitor.HMonitor)
if ($physicalMonitors.Length -eq 0) {
    throw "No physical monitor handles were found for '$MonitorName'."
}

$switchSucceeded = $false

try {
    foreach ($physicalMonitor in $physicalMonitors) {
        if ([NativeDisplayMapper]::SetInput($physicalMonitor, [uint32]$InputValue)) {
            $switchSucceeded = $true
        }
    }
}
finally {
    [NativeDisplayMapper]::ReleasePhysicalMonitors($physicalMonitors)
}

if (-not $switchSucceeded) {
    throw "Setting VCP 0x60 to value $InputValue failed for '$MonitorName'."
}

Write-Output "OK"
