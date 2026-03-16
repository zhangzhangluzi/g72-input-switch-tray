param(
    [string]$MonitorName,

    [switch]$PrimaryOnly,

    [switch]$ExtendAll,

    [switch]$DetachMonitor,

    [switch]$AttachMonitor,

    [switch]$Summary
)

$ErrorActionPreference = "Stop"

Add-Type @"
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;

public static class NativeDisplayTopology
{
    [StructLayout(LayoutKind.Sequential)]
    public struct POINTL
    {
        public int x;
        public int y;
    }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Auto)]
    public struct DEVMODE
    {
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)]
        public string dmDeviceName;
        public short dmSpecVersion;
        public short dmDriverVersion;
        public short dmSize;
        public short dmDriverExtra;
        public int dmFields;
        public POINTL dmPosition;
        public int dmDisplayOrientation;
        public int dmDisplayFixedOutput;
        public short dmColor;
        public short dmDuplex;
        public short dmYResolution;
        public short dmTTOption;
        public short dmCollate;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)]
        public string dmFormName;
        public short dmLogPixels;
        public int dmBitsPerPel;
        public int dmPelsWidth;
        public int dmPelsHeight;
        public int dmDisplayFlags;
        public int dmDisplayFrequency;
        public int dmICMMethod;
        public int dmICMIntent;
        public int dmMediaType;
        public int dmDitherType;
        public int dmReserved1;
        public int dmReserved2;
        public int dmPanningWidth;
        public int dmPanningHeight;
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

    public class DisplayInfo
    {
        public string DeviceName;
        public string DeviceString;
        public string DeviceId;
        public string ProductCode;
        public bool Attached;
        public bool Primary;
        public int Width;
        public int Height;
        public int PositionX;
        public int PositionY;
    }

    private const int DISPLAY_DEVICE_ATTACHED_TO_DESKTOP = 0x00000001;
    private const int DISPLAY_DEVICE_PRIMARY_DEVICE = 0x00000004;
    private const int ENUM_CURRENT_SETTINGS = -1;
    private const int ENUM_REGISTRY_SETTINGS = -2;
    private const int DM_POSITION = 0x00000020;
    private const int DM_PELSWIDTH = 0x00080000;
    private const int DM_PELSHEIGHT = 0x00100000;
    private const int CDS_UPDATEREGISTRY = 0x00000001;
    private const int CDS_SET_PRIMARY = 0x00000010;
    private const int CDS_NORESET = 0x10000000;
    private const int DISP_CHANGE_SUCCESSFUL = 0;

    [DllImport("user32.dll", CharSet = CharSet.Auto)]
    private static extern bool EnumDisplayDevices(
        string lpDevice,
        uint iDevNum,
        ref DISPLAY_DEVICE lpDisplayDevice,
        uint dwFlags
    );

    [DllImport("user32.dll", CharSet = CharSet.Auto)]
    private static extern bool EnumDisplaySettingsEx(
        string lpszDeviceName,
        int iModeNum,
        ref DEVMODE lpDevMode,
        uint dwFlags
    );

    [DllImport("user32.dll", CharSet = CharSet.Auto)]
    private static extern int ChangeDisplaySettingsEx(
        string lpszDeviceName,
        ref DEVMODE lpDevMode,
        IntPtr hwnd,
        uint dwflags,
        IntPtr lParam
    );

    [DllImport("user32.dll", CharSet = CharSet.Auto)]
    private static extern int ChangeDisplaySettingsEx(
        string lpszDeviceName,
        IntPtr lpDevMode,
        IntPtr hwnd,
        uint dwflags,
        IntPtr lParam
    );

    public static List<DisplayInfo> GetDisplays()
    {
        var displays = new List<DisplayInfo>();
        uint index = 0;

        while (true)
        {
            var device = CreateDisplayDevice();
            if (!EnumDisplayDevices(null, index, ref device, 0))
            {
                break;
            }

            if (!string.IsNullOrWhiteSpace(device.DeviceName))
            {
                var info = new DisplayInfo();
                info.DeviceName = device.DeviceName;
                info.DeviceString = device.DeviceString ?? string.Empty;
                info.DeviceId = device.DeviceID ?? string.Empty;
                info.ProductCode = ExtractProductCode(device.DeviceID);
                info.Attached = (device.StateFlags & DISPLAY_DEVICE_ATTACHED_TO_DESKTOP) != 0;
                info.Primary = (device.StateFlags & DISPLAY_DEVICE_PRIMARY_DEVICE) != 0;

                var mode = CreateDevMode();
                if (EnumDisplaySettingsEx(device.DeviceName, ENUM_CURRENT_SETTINGS, ref mode, 0))
                {
                    info.Width = mode.dmPelsWidth;
                    info.Height = mode.dmPelsHeight;
                    info.PositionX = mode.dmPosition.x;
                    info.PositionY = mode.dmPosition.y;
                }

                displays.Add(info);
            }

            index += 1;
        }

        return displays;
    }

    public static void SwitchToPrimaryOnly()
    {
        var displays = GetDisplays();
        var activeDisplays = displays.FindAll(display => display.Attached);
        if (activeDisplays.Count == 0)
        {
            throw new InvalidOperationException("No active desktop displays were found.");
        }

        var primaryDisplay = activeDisplays.Find(display => display.Primary) ?? activeDisplays[0];
        ApplyPrimaryDisplay(primaryDisplay.DeviceName);

        foreach (var display in activeDisplays)
        {
            if (string.Equals(display.DeviceName, primaryDisplay.DeviceName, StringComparison.OrdinalIgnoreCase))
            {
                continue;
            }

            DetachDisplay(display.DeviceName);
        }

        var finalResult = ChangeDisplaySettingsEx(null, IntPtr.Zero, IntPtr.Zero, 0, IntPtr.Zero);
        if (finalResult != DISP_CHANGE_SUCCESSFUL)
        {
            throw new InvalidOperationException("Final display topology apply failed with code " + finalResult + ".");
        }
    }

    public static void DetachDisplayByDeviceName(string deviceName)
    {
        if (string.IsNullOrWhiteSpace(deviceName))
        {
            throw new InvalidOperationException("Target display device name was empty.");
        }

        var displays = GetDisplays();
        var activeDisplays = displays.FindAll(display => display.Attached);
        if (activeDisplays.Count == 0)
        {
            throw new InvalidOperationException("No active desktop displays were found.");
        }

        var targetDisplay = activeDisplays.Find(
            display => string.Equals(display.DeviceName, deviceName, StringComparison.OrdinalIgnoreCase)
        );
        if (targetDisplay == null)
        {
            throw new InvalidOperationException("Target display " + deviceName + " is not currently attached.");
        }

        if (targetDisplay.Primary)
        {
            throw new InvalidOperationException("Target display " + deviceName + " is currently the primary desktop and cannot be detached directly.");
        }

        DetachDisplay(targetDisplay.DeviceName);

        var finalResult = ChangeDisplaySettingsEx(null, IntPtr.Zero, IntPtr.Zero, 0, IntPtr.Zero);
        if (finalResult != DISP_CHANGE_SUCCESSFUL)
        {
            throw new InvalidOperationException("Final display topology apply failed with code " + finalResult + ".");
        }
    }

    public static void SwitchToExtendedDesktop()
    {
        var displays = GetDisplays();
        var activeDisplays = displays.FindAll(display => display.Attached);
        if (activeDisplays.Count == 0)
        {
            throw new InvalidOperationException("No active desktop displays were found.");
        }

        var primaryDisplay = activeDisplays.Find(display => display.Primary) ?? activeDisplays[0];
        int nextX = primaryDisplay.PositionX + Math.Max(primaryDisplay.Width, 1);
        bool changed = false;

        foreach (var display in displays)
        {
            if (display.Attached)
            {
                continue;
            }

            nextX += AttachDisplay(display.DeviceName, nextX, primaryDisplay.PositionY);
            changed = true;
        }

        if (!changed)
        {
            return;
        }

        var finalResult = ChangeDisplaySettingsEx(null, IntPtr.Zero, IntPtr.Zero, 0, IntPtr.Zero);
        if (finalResult != DISP_CHANGE_SUCCESSFUL)
        {
            throw new InvalidOperationException("Final display topology apply failed with code " + finalResult + ".");
        }
    }

    public static void AttachDisplayByDeviceName(string deviceName)
    {
        if (string.IsNullOrWhiteSpace(deviceName))
        {
            throw new InvalidOperationException("Target display device name was empty.");
        }

        var displays = GetDisplays();
        var activeDisplays = displays.FindAll(display => display.Attached);
        if (activeDisplays.Count == 0)
        {
            throw new InvalidOperationException("No active desktop displays were found.");
        }

        var targetDisplay = displays.Find(
            display => string.Equals(display.DeviceName, deviceName, StringComparison.OrdinalIgnoreCase)
        );
        if (targetDisplay == null)
        {
            throw new InvalidOperationException("Target display " + deviceName + " was not found.");
        }

        if (targetDisplay.Attached)
        {
            return;
        }

        int nextX = 0;
        foreach (var display in activeDisplays)
        {
            int rightEdge = display.PositionX + Math.Max(display.Width, 1);
            if (rightEdge > nextX)
            {
                nextX = rightEdge;
            }
        }

        var primaryDisplay = activeDisplays.Find(display => display.Primary) ?? activeDisplays[0];
        AttachDisplay(targetDisplay.DeviceName, nextX, primaryDisplay.PositionY);

        var finalResult = ChangeDisplaySettingsEx(null, IntPtr.Zero, IntPtr.Zero, 0, IntPtr.Zero);
        if (finalResult != DISP_CHANGE_SUCCESSFUL)
        {
            throw new InvalidOperationException("Final display topology apply failed with code " + finalResult + ".");
        }
    }

    private static void ApplyPrimaryDisplay(string deviceName)
    {
        var mode = CreateDevMode();
        if (!EnumDisplaySettingsEx(deviceName, ENUM_CURRENT_SETTINGS, ref mode, 0))
        {
            throw new InvalidOperationException("Failed to read current mode for primary display " + deviceName + ".");
        }

        mode.dmFields |= DM_POSITION | DM_PELSWIDTH | DM_PELSHEIGHT;
        mode.dmPosition.x = 0;
        mode.dmPosition.y = 0;

        var result = ChangeDisplaySettingsEx(
            deviceName,
            ref mode,
            IntPtr.Zero,
            (uint)(CDS_UPDATEREGISTRY | CDS_NORESET | CDS_SET_PRIMARY),
            IntPtr.Zero
        );

        if (result != DISP_CHANGE_SUCCESSFUL)
        {
            throw new InvalidOperationException("Failed to set primary display " + deviceName + " with code " + result + ".");
        }
    }

    private static void DetachDisplay(string deviceName)
    {
        var mode = CreateDevMode();
        if (!EnumDisplaySettingsEx(deviceName, ENUM_CURRENT_SETTINGS, ref mode, 0))
        {
            throw new InvalidOperationException("Failed to read current mode for secondary display " + deviceName + ".");
        }

        mode.dmFields = DM_POSITION | DM_PELSWIDTH | DM_PELSHEIGHT;
        mode.dmPosition.x = 0;
        mode.dmPosition.y = 0;
        mode.dmPelsWidth = 0;
        mode.dmPelsHeight = 0;

        var result = ChangeDisplaySettingsEx(
            deviceName,
            ref mode,
            IntPtr.Zero,
            (uint)(CDS_UPDATEREGISTRY | CDS_NORESET),
            IntPtr.Zero
        );

        if (result != DISP_CHANGE_SUCCESSFUL)
        {
            throw new InvalidOperationException("Failed to detach display " + deviceName + " with code " + result + ".");
        }
    }

    private static int AttachDisplay(string deviceName, int positionX, int positionY)
    {
        var mode = CreateDevMode();
        if (
            !EnumDisplaySettingsEx(deviceName, ENUM_REGISTRY_SETTINGS, ref mode, 0) &&
            !EnumDisplaySettingsEx(deviceName, ENUM_CURRENT_SETTINGS, ref mode, 0)
        )
        {
            throw new InvalidOperationException("Failed to read stored mode for detached display " + deviceName + ".");
        }

        if (mode.dmPelsWidth <= 0)
        {
            mode.dmPelsWidth = 1920;
        }

        if (mode.dmPelsHeight <= 0)
        {
            mode.dmPelsHeight = 1080;
        }

        mode.dmFields |= DM_POSITION | DM_PELSWIDTH | DM_PELSHEIGHT;
        mode.dmPosition.x = positionX;
        mode.dmPosition.y = positionY;

        var result = ChangeDisplaySettingsEx(
            deviceName,
            ref mode,
            IntPtr.Zero,
            (uint)(CDS_UPDATEREGISTRY | CDS_NORESET),
            IntPtr.Zero
        );

        if (result != DISP_CHANGE_SUCCESSFUL)
        {
            throw new InvalidOperationException("Failed to attach display " + deviceName + " with code " + result + ".");
        }

        return mode.dmPelsWidth;
    }

    private static DISPLAY_DEVICE CreateDisplayDevice()
    {
        var device = new DISPLAY_DEVICE();
        device.cb = Marshal.SizeOf(typeof(DISPLAY_DEVICE));
        return device;
    }

    private static DEVMODE CreateDevMode()
    {
        var mode = new DEVMODE();
        mode.dmSize = (short)Marshal.SizeOf(typeof(DEVMODE));
        return mode;
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

function Get-DisplayEntries {
    param(
        [array]$Displays,
        [hashtable]$FriendlyNameMap
    )

    $entries = @()

    foreach ($display in $Displays) {
        $friendlyName = $null
        $productCodeKey = [string]$display.ProductCode
        if (-not [string]::IsNullOrWhiteSpace($productCodeKey)) {
            $productCodeKey = $productCodeKey.ToUpperInvariant()
        }

        if ($FriendlyNameMap.ContainsKey($productCodeKey)) {
            $friendlyName = $FriendlyNameMap[$productCodeKey]
        }

        $displayName = if ([string]::IsNullOrWhiteSpace($friendlyName)) {
            if ([string]::IsNullOrWhiteSpace($display.ProductCode)) {
                $display.DeviceString
            } else {
                $display.ProductCode
            }
        } else {
            $friendlyName
        }

        $entries += [pscustomobject]@{
            Display               = $display
            FriendlyName          = $friendlyName
            DisplayName           = $displayName
            ProductCode           = $display.ProductCode
            DeviceName            = $display.DeviceName
            Attached              = [bool]$display.Attached
            Primary               = [bool]$display.Primary
            NormalizedDisplayName = Normalize-MonitorToken $displayName
            NormalizedProductCode = Normalize-MonitorToken $display.ProductCode
        }
    }

    return @($entries)
}

function Get-AvailableMonitorNames {
    param(
        [array]$DisplayEntries
    )

    $names = @()

    foreach ($entry in $DisplayEntries) {
        if (-not [string]::IsNullOrWhiteSpace($entry.DisplayName)) {
            $names += $entry.DisplayName
        }
    }

    return @($names | Sort-Object -Unique)
}

function Select-TargetDisplayEntry {
    param(
        [array]$DisplayEntries,
        [string]$MonitorName
    )

    if ([string]::IsNullOrWhiteSpace($MonitorName)) {
        return $null
    }

    $requestedName = $MonitorName.Trim()
    $requestedToken = Normalize-MonitorToken $requestedName
    $exactMatches = @(
        $DisplayEntries | Where-Object {
            $_.DisplayName -ieq $requestedName -or
            $_.ProductCode -ieq $requestedName -or
            $_.DeviceName -ieq $requestedName
        }
    )

    if ($exactMatches.Count -eq 1) {
        return $exactMatches[0]
    }

    if (-not [string]::IsNullOrWhiteSpace($requestedToken)) {
        $normalizedMatches = @(
            $DisplayEntries | Where-Object {
                $_.NormalizedDisplayName -eq $requestedToken -or $_.NormalizedProductCode -eq $requestedToken
            }
        )

        if ($normalizedMatches.Count -eq 1) {
            return $normalizedMatches[0]
        }

        $partialMatches = @(
            $DisplayEntries | Where-Object {
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

try {
    $friendlyNameMap = Get-FriendlyNameMap
    $displays = [NativeDisplayTopology]::GetDisplays()
    $displayEntries = Get-DisplayEntries -Displays $displays -FriendlyNameMap $friendlyNameMap
    $availableMonitors = Get-AvailableMonitorNames -DisplayEntries $displayEntries

    if ($Summary) {
        Write-Output ($displays | ConvertTo-Json -Compress)
        exit 0
    }

    if ($DetachMonitor -or $AttachMonitor) {
        $targetDisplayEntry = Select-TargetDisplayEntry -DisplayEntries $displayEntries -MonitorName $MonitorName
        if ($null -eq $targetDisplayEntry) {
            $availableText = if ($availableMonitors.Count -gt 0) {
                $availableMonitors -join ", "
            } else {
                "<none>"
            }

            throw "No monitor matched '$MonitorName'. Available monitors: $availableText"
        }

        if ($DetachMonitor) {
            [NativeDisplayTopology]::DetachDisplayByDeviceName($targetDisplayEntry.DeviceName)
            Write-Output (@{
                ok = $true
                mode = "detach-monitor"
                monitor = $targetDisplayEntry.DisplayName
                deviceName = $targetDisplayEntry.DeviceName
            } | ConvertTo-Json -Compress)
            exit 0
        }

        if ($AttachMonitor) {
            [NativeDisplayTopology]::AttachDisplayByDeviceName($targetDisplayEntry.DeviceName)
            Write-Output (@{
                ok = $true
                mode = "attach-monitor"
                monitor = $targetDisplayEntry.DisplayName
                deviceName = $targetDisplayEntry.DeviceName
            } | ConvertTo-Json -Compress)
            exit 0
        }
    }

    if ($PrimaryOnly) {
        [NativeDisplayTopology]::SwitchToPrimaryOnly()
        Write-Output (@{
            ok = $true
            mode = "primary-only"
        } | ConvertTo-Json -Compress)
        exit 0
    }

    if ($ExtendAll) {
        [NativeDisplayTopology]::SwitchToExtendedDesktop()
        Write-Output (@{
            ok = $true
            mode = "extend-all"
        } | ConvertTo-Json -Compress)
        exit 0
    }

    throw "No topology action was provided."
}
catch {
    $message = $_.Exception.Message
    if ([string]::IsNullOrWhiteSpace($message)) {
        $message = [string]$_
    }

    throw $message.Trim()
}
