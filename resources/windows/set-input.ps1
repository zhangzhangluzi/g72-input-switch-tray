param(
    [string]$MonitorName,

    [string]$GdiDeviceName,

    [ValidateRange(1, 255)]
    [int]$InputValue,

    [switch]$ListOnly,

    [switch]$ReadInputValue,

    [switch]$ReadCapabilities
)

$ErrorActionPreference = "Stop"

if (-not $ListOnly -and -not $ReadInputValue -and -not $ReadCapabilities) {
    if ([string]::IsNullOrWhiteSpace($MonitorName) -and [string]::IsNullOrWhiteSpace($GdiDeviceName)) {
        throw "MonitorName or GdiDeviceName was not provided."
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

    [DllImport("dxva2.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool GetVCPFeatureAndVCPFeatureReply(
        IntPtr monitor,
        byte code,
        out uint vcpType,
        out uint currentValue,
        out uint maximumValue
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

    public static bool TryGetInput(PHYSICAL_MONITOR monitor, out uint currentValue, out uint maximumValue)
    {
        uint vcpType;
        return GetVCPFeatureAndVCPFeatureReply(monitor.hPhysicalMonitor, 0x60, out vcpType, out currentValue, out maximumValue);
    }

    [DllImport("dxva2.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool GetCapabilitiesStringLength(
        IntPtr monitor,
        out uint length
    );

    [DllImport("dxva2.dll", CharSet = CharSet.Ansi, SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool CapabilitiesRequestAndCapabilitiesReply(
        IntPtr monitor,
        System.Text.StringBuilder capabilitiesString,
        uint length
    );

    public static string GetCapabilities(PHYSICAL_MONITOR monitor)
    {
        uint length;
        if (!GetCapabilitiesStringLength(monitor.hPhysicalMonitor, out length) || length == 0)
        {
            return string.Empty;
        }

        var buffer = new System.Text.StringBuilder((int)length);
        if (!CapabilitiesRequestAndCapabilitiesReply(monitor.hPhysicalMonitor, buffer, length))
        {
            return string.Empty;
        }

        return buffer.ToString();
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

function Normalize-MonitorToken {
    param(
        [string]$Value
    )

    if ([string]::IsNullOrWhiteSpace($Value)) {
        return ""
    }

    return (($Value -replace '[^0-9A-Za-z]+', '')).ToUpperInvariant()
}

function Get-MonitorEntries {
    param(
        [array]$LogicalMonitors,
        [hashtable]$FriendlyNameMap
    )

    $entries = @()

    foreach ($logicalMonitor in $LogicalMonitors) {
        $friendlyName = $null
        $productCodeKey = [string]$logicalMonitor.DisplayProductCode
        if (-not [string]::IsNullOrWhiteSpace($productCodeKey)) {
            $productCodeKey = $productCodeKey.ToUpperInvariant()
        }

        if ($FriendlyNameMap.ContainsKey($productCodeKey)) {
            $friendlyName = $FriendlyNameMap[$productCodeKey]
        }

        $displayName = if ([string]::IsNullOrWhiteSpace($friendlyName)) {
            $logicalMonitor.DisplayProductCode
        } else {
            $friendlyName
        }

        $entries += [pscustomobject]@{
            LogicalMonitor        = $logicalMonitor
            FriendlyName          = $friendlyName
            DisplayName           = $displayName
            ProductCode           = $logicalMonitor.DisplayProductCode
            GdiDeviceName         = $logicalMonitor.GdiDeviceName
            NormalizedDisplayName = Normalize-MonitorToken $displayName
            NormalizedProductCode = Normalize-MonitorToken $logicalMonitor.DisplayProductCode
        }
    }

    return @($entries)
}

function Get-AvailableMonitorNames {
    param(
        [array]$MonitorEntries
    )

    $names = @()

    foreach ($entry in $MonitorEntries) {
        if (-not [string]::IsNullOrWhiteSpace($entry.DisplayName)) {
            $names += $entry.DisplayName
        }
    }

    return @($names | Sort-Object -Unique)
}

function Select-TargetMonitorEntry {
    param(
        [array]$MonitorEntries,
        [string]$MonitorName,
        [string]$GdiDeviceName
    )

    if (-not [string]::IsNullOrWhiteSpace($GdiDeviceName)) {
        $requestedDeviceName = $GdiDeviceName.Trim()
        $deviceMatches = @(
            $MonitorEntries | Where-Object {
                $_.GdiDeviceName -ieq $requestedDeviceName
            }
        )

        if ($deviceMatches.Count -eq 1) {
            return $deviceMatches[0]
        }
    }

    if ([string]::IsNullOrWhiteSpace($MonitorName)) {
        return $null
    }

    $requestedName = $MonitorName.Trim()
    $requestedToken = Normalize-MonitorToken $requestedName
    $exactMatches = @(
        $MonitorEntries | Where-Object {
            $_.DisplayName -ieq $requestedName -or $_.ProductCode -ieq $requestedName
        }
    )

    if ($exactMatches.Count -eq 1) {
        return $exactMatches[0]
    }

    if (-not [string]::IsNullOrWhiteSpace($requestedToken)) {
        $normalizedMatches = @(
            $MonitorEntries | Where-Object {
                $_.NormalizedDisplayName -eq $requestedToken -or $_.NormalizedProductCode -eq $requestedToken
            }
        )

        if ($normalizedMatches.Count -eq 1) {
            return $normalizedMatches[0]
        }

        $partialMatches = @(
            $MonitorEntries | Where-Object {
                ($_.NormalizedDisplayName.Length -gt 0 -and (
                    $_.NormalizedDisplayName.Contains($requestedToken) -or
                    $requestedToken.Contains($_.NormalizedDisplayName)
                )) -or
                ($_.NormalizedProductCode.Length -gt 0 -and (
                    $_.NormalizedProductCode.Contains($requestedToken) -or
                    $requestedToken.Contains($_.NormalizedProductCode)
                ))
            }
        )

        if ($partialMatches.Count -eq 1) {
            return $partialMatches[0]
        }
    }

    return $null
}

function Resolve-ErrorMessage {
    param(
        $ErrorRecord
    )

    if ($null -eq $ErrorRecord) {
        return "Unknown error."
    }

    $message = $ErrorRecord.Exception.Message
    if ([string]::IsNullOrWhiteSpace($message)) {
        $message = [string]$ErrorRecord
    }

    return $message.Trim()
}

try {
    $friendlyNameMap = Get-FriendlyNameMap
    $logicalMonitors = [NativeDisplayMapper]::EnumerateLogicalMonitors()
    $monitorEntries = Get-MonitorEntries -LogicalMonitors $logicalMonitors -FriendlyNameMap $friendlyNameMap
    $availableMonitors = Get-AvailableMonitorNames -MonitorEntries $monitorEntries

    if ($ListOnly) {
        Write-Output (ConvertTo-Json -InputObject @($availableMonitors) -Compress)
        exit 0
    }

    $targetMonitorEntry = Select-TargetMonitorEntry -MonitorEntries $monitorEntries -MonitorName $MonitorName -GdiDeviceName $GdiDeviceName
    if ($null -eq $targetMonitorEntry) {
        $availableText = if ($availableMonitors.Count -gt 0) {
            $availableMonitors -join ", "
        } else {
            "<none>"
        }

        if (-not [string]::IsNullOrWhiteSpace($GdiDeviceName)) {
            throw "No monitor matched GDI device '$GdiDeviceName'. Available monitors: $availableText"
        }

        throw "No monitor matched '$MonitorName'. Available monitors: $availableText"
    }

    $targetLogicalMonitor = $targetMonitorEntry.LogicalMonitor
    $targetDisplayName = $targetMonitorEntry.DisplayName
    $physicalMonitors = [NativeDisplayMapper]::GetPhysicalMonitorsForDisplay($targetLogicalMonitor.HMonitor)
    if ($physicalMonitors.Length -eq 0) {
        throw "No physical monitor handles were found for '$targetDisplayName'."
    }

    if ($ReadInputValue) {
        try {
            foreach ($physicalMonitor in $physicalMonitors) {
                $currentValue = 0
                $maximumValue = 0
                if ([NativeDisplayMapper]::TryGetInput($physicalMonitor, [ref]$currentValue, [ref]$maximumValue)) {
                    Write-Output (@{
                        monitor = $targetDisplayName
                        gdiDeviceName = $targetMonitorEntry.GdiDeviceName
                        currentInputValue = [int]$currentValue
                        maximumValue = [int]$maximumValue
                    } | ConvertTo-Json -Compress)
                    exit 0
                }
            }
        }
        finally {
            [NativeDisplayMapper]::ReleasePhysicalMonitors($physicalMonitors)
        }

        throw "Reading VCP 0x60 failed for '$targetDisplayName'."
    }

    if ($ReadCapabilities) {
        try {
            foreach ($physicalMonitor in $physicalMonitors) {
                $capabilities = [NativeDisplayMapper]::GetCapabilities($physicalMonitor)
                if (-not [string]::IsNullOrWhiteSpace($capabilities)) {
                    Write-Output (@{
                        monitor = $targetDisplayName
                        gdiDeviceName = $targetMonitorEntry.GdiDeviceName
                        capabilities = $capabilities
                    } | ConvertTo-Json -Compress)
                    exit 0
                }
            }
        }
        finally {
            [NativeDisplayMapper]::ReleasePhysicalMonitors($physicalMonitors)
        }

        throw "Reading capabilities failed for '$targetDisplayName'."
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
        throw "Setting VCP 0x60 to value $InputValue failed for '$targetDisplayName'."
    }

    Write-Output "OK"
}
catch {
    [Console]::Error.WriteLine((Resolve-ErrorMessage $_))
    exit 1
}
