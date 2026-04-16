param(
    [string]$MonitorName,

    [Nullable[int]]$PreferredPositionX,

    [Nullable[int]]$PreferredPositionY,

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
    public delegate bool MonitorEnumProc(IntPtr hMonitor, IntPtr hdc, ref RECT rect, IntPtr data);

    [StructLayout(LayoutKind.Sequential)]
    public struct RECT
    {
        public int Left;
        public int Top;
        public int Right;
        public int Bottom;
    }

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
        public int BitsPerPel;
        public int DisplayFrequency;
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

    public class LogicalMonitorInfo
    {
        public string GdiDeviceName;
        public string DisplayDeviceId;
        public string DisplayProductCode;
    }

    private const int DISPLAY_DEVICE_ATTACHED_TO_DESKTOP = 0x00000001;
    private const int DISPLAY_DEVICE_PRIMARY_DEVICE = 0x00000004;
    private const int ENUM_CURRENT_SETTINGS = -1;
    private const int ENUM_REGISTRY_SETTINGS = -2;
    private const int DM_POSITION = 0x00000020;
    private const int DM_BITSPERPEL = 0x00040000;
    private const int DM_PELSWIDTH = 0x00080000;
    private const int DM_PELSHEIGHT = 0x00100000;
    private const int DM_DISPLAYFREQUENCY = 0x00400000;
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

    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool EnumDisplayMonitors(
        IntPtr hdc,
        IntPtr clip,
        MonitorEnumProc callback,
        IntPtr data
    );

    [DllImport("user32.dll", CharSet = CharSet.Auto)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool GetMonitorInfo(
        IntPtr hMonitor,
        ref MONITORINFOEX info
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
                    info.BitsPerPel = mode.dmBitsPerPel;
                    info.DisplayFrequency = mode.dmDisplayFrequency;
                }

                displays.Add(info);
            }

            index += 1;
        }

        return displays;
    }

    public static List<LogicalMonitorInfo> GetLogicalMonitors()
    {
        var results = new List<LogicalMonitorInfo>();

        MonitorEnumProc callback = delegate(IntPtr hMonitor, IntPtr hdc, ref RECT rect, IntPtr data)
        {
            var info = new MONITORINFOEX();
            info.cbSize = Marshal.SizeOf(typeof(MONITORINFOEX));

            if (!GetMonitorInfo(hMonitor, ref info))
            {
                return true;
            }

            var display = CreateDisplayDevice();
            if (!EnumDisplayDevices(info.szDevice, 0, ref display, 0))
            {
                return true;
            }

            var logicalMonitor = new LogicalMonitorInfo();
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

        return results;
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
            if (activeDisplays.Count < 2)
            {
                throw new InvalidOperationException("Target display " + deviceName + " is currently the only active desktop display and cannot be detached.");
            }

            var replacementPrimary = activeDisplays.Find(
                display => !string.Equals(display.DeviceName, targetDisplay.DeviceName, StringComparison.OrdinalIgnoreCase)
            );
            if (replacementPrimary == null)
            {
                throw new InvalidOperationException("No replacement primary display was found before detaching " + deviceName + ".");
            }

            ApplyPrimaryDisplay(replacementPrimary.DeviceName);
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
        AttachDisplayByDeviceName(deviceName, 0, 0, false, 0, 0, 0, 0);
    }

    public static void AttachDisplayByDeviceName(
        string deviceName,
        int preferredPositionX,
        int preferredPositionY,
        bool usePreferredPosition,
        int preferredWidth,
        int preferredHeight,
        int preferredBitsPerPel,
        int preferredDisplayFrequency
    )
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

        var primaryDisplay = activeDisplays.Find(display => display.Primary) ?? activeDisplays[0];
        int positionX = preferredPositionX;
        int positionY = preferredPositionY;

        if (!usePreferredPosition)
        {
            int nextX = 0;
            foreach (var display in activeDisplays)
            {
                int rightEdge = display.PositionX + Math.Max(display.Width, 1);
                if (rightEdge > nextX)
                {
                    nextX = rightEdge;
                }
            }

            positionX = nextX;
            positionY = primaryDisplay.PositionY;
        }

        AttachDisplay(
            targetDisplay.DeviceName,
            positionX,
            positionY,
            preferredWidth,
            preferredHeight,
            preferredBitsPerPel,
            preferredDisplayFrequency
        );

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
        return AttachDisplay(deviceName, positionX, positionY, 0, 0, 0, 0);
    }

    private static int AttachDisplay(
        string deviceName,
        int positionX,
        int positionY,
        int preferredWidth,
        int preferredHeight,
        int preferredBitsPerPel,
        int preferredDisplayFrequency
    )
    {
        var mode = CreateDevMode();
        if (
            !EnumDisplaySettingsEx(deviceName, ENUM_REGISTRY_SETTINGS, ref mode, 0) &&
            !EnumDisplaySettingsEx(deviceName, ENUM_CURRENT_SETTINGS, ref mode, 0)
        )
        {
            throw new InvalidOperationException("Failed to read stored mode for detached display " + deviceName + ".");
        }

        if (preferredWidth > 0)
        {
            mode.dmPelsWidth = preferredWidth;
        }
        else if (mode.dmPelsWidth <= 0)
        {
            mode.dmPelsWidth = 1920;
        }

        if (preferredHeight > 0)
        {
            mode.dmPelsHeight = preferredHeight;
        }
        else if (mode.dmPelsHeight <= 0)
        {
            mode.dmPelsHeight = 1080;
        }

        if (preferredBitsPerPel > 0)
        {
            mode.dmBitsPerPel = preferredBitsPerPel;
        }

        if (preferredDisplayFrequency > 0)
        {
            mode.dmDisplayFrequency = preferredDisplayFrequency;
        }

        mode.dmFields |= DM_POSITION | DM_PELSWIDTH | DM_PELSHEIGHT;
        if (mode.dmBitsPerPel > 0)
        {
            mode.dmFields |= DM_BITSPERPEL;
        }

        if (mode.dmDisplayFrequency > 0)
        {
            mode.dmFields |= DM_DISPLAYFREQUENCY;
        }
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

function Get-DisplayCachePath {
    $basePath = if ([string]::IsNullOrWhiteSpace($env:APPDATA)) {
        Join-Path $env:TEMP "g72-input-switch-tray"
    } else {
        Join-Path $env:APPDATA "g72-input-switch-tray"
    }

    return Join-Path $basePath "display-topology-cache.json"
}

function Read-DisplayCache {
    $cachePath = Get-DisplayCachePath
    if (-not (Test-Path -LiteralPath $cachePath)) {
        return @{}
    }

    try {
        $raw = Get-Content -LiteralPath $cachePath -Raw -ErrorAction Stop
        if ([string]::IsNullOrWhiteSpace($raw)) {
            return @{}
        }

        $parsed = ConvertFrom-Json -InputObject $raw -ErrorAction Stop
        $cache = @{}

        if ($parsed -is [System.Collections.IEnumerable] -and -not ($parsed -is [string])) {
            foreach ($entry in @($parsed)) {
                if ($null -ne $entry -and -not [string]::IsNullOrWhiteSpace($entry.DeviceName)) {
                    $cache[$entry.DeviceName.ToUpperInvariant()] = @{
                        DeviceName   = [string]$entry.DeviceName
                        DisplayName  = [string]$entry.DisplayName
                        FriendlyName = [string]$entry.FriendlyName
                        ProductCode  = [string]$entry.ProductCode
                        Width        = [int]$entry.Width
                        Height       = [int]$entry.Height
                        BitsPerPel   = [int]$entry.BitsPerPel
                        DisplayFrequency = [int]$entry.DisplayFrequency
                        UpdatedAt    = [string]$entry.UpdatedAt
                    }
                }
            }

            return $cache
        }

        if ($parsed -is [hashtable]) {
            foreach ($key in $parsed.Keys) {
                $entry = $parsed[$key]
                if ($entry -is [hashtable] -and -not [string]::IsNullOrWhiteSpace($entry.DeviceName)) {
                    $cache[$entry.DeviceName.ToUpperInvariant()] = $entry
                    continue
                }

                if (-not [string]::IsNullOrWhiteSpace($key)) {
                    $cache[$key.ToUpperInvariant()] = @{
                        DeviceName   = $key
                        DisplayName  = [string]$entry.DisplayName
                        FriendlyName = [string]$entry.FriendlyName
                        ProductCode  = [string]$entry.ProductCode
                        Width        = [int]$entry.Width
                        Height       = [int]$entry.Height
                        BitsPerPel   = [int]$entry.BitsPerPel
                        DisplayFrequency = [int]$entry.DisplayFrequency
                        UpdatedAt    = [string]$entry.UpdatedAt
                    }
                }
            }

            return $cache
        }

        if ($null -ne $parsed -and -not [string]::IsNullOrWhiteSpace($parsed.DeviceName)) {
            $cache[$parsed.DeviceName.ToUpperInvariant()] = @{
                DeviceName   = [string]$parsed.DeviceName
                DisplayName  = [string]$parsed.DisplayName
                FriendlyName = [string]$parsed.FriendlyName
                ProductCode  = [string]$parsed.ProductCode
                Width        = [int]$parsed.Width
                Height       = [int]$parsed.Height
                BitsPerPel   = [int]$parsed.BitsPerPel
                DisplayFrequency = [int]$parsed.DisplayFrequency
                UpdatedAt    = [string]$parsed.UpdatedAt
            }

            return $cache
        }
    } catch {
        return @{}
    }

    return @{}
}

function Save-DisplayCache {
    param(
        [hashtable]$DisplayCache
    )

    if ($null -eq $DisplayCache) {
        return
    }

    $cachePath = Get-DisplayCachePath
    $cacheDirectory = Split-Path -Path $cachePath -Parent
    if (-not (Test-Path -LiteralPath $cacheDirectory)) {
        New-Item -ItemType Directory -Path $cacheDirectory -Force | Out-Null
    }

    $cacheEntries = @(
        $DisplayCache.Values |
            Where-Object { $null -ne $_ -and -not [string]::IsNullOrWhiteSpace($_.DeviceName) } |
            Sort-Object DeviceName
    )
    $json = ConvertTo-Json -InputObject $cacheEntries -Depth 4
    Set-Content -LiteralPath $cachePath -Value $json -Encoding UTF8
}

function Set-DisplayCacheEntry {
    param(
        [hashtable]$DisplayCache,
        [string]$DeviceName,
        [string]$DisplayName,
        [string]$FriendlyName,
        [string]$ProductCode,
        [int]$Width,
        [int]$Height,
        [int]$BitsPerPel,
        [int]$DisplayFrequency
    )

    if ($null -eq $DisplayCache -or [string]::IsNullOrWhiteSpace($DeviceName)) {
        return
    }

    $cacheKey = $DeviceName.ToUpperInvariant()
    $DisplayCache[$cacheKey] = @{
        DeviceName   = $DeviceName
        DisplayName  = $DisplayName
        FriendlyName = $FriendlyName
        ProductCode  = $ProductCode
        Width        = $Width
        Height       = $Height
        BitsPerPel   = $BitsPerPel
        DisplayFrequency = $DisplayFrequency
        UpdatedAt    = (Get-Date).ToString("o")
    }
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

function Test-IsGenericDisplayLabel {
    param(
        [string]$Value
    )

    $text = [string]$Value
    if ([string]::IsNullOrWhiteSpace($text)) {
        return $true
    }

    return $text -like "VEN_*" -or
        $text -like "AMD Radeon *" -or
        $text -like "GameViewer Virtual Display Adapter"
}

function Get-DisplayEntries {
    param(
        [array]$Displays,
        [array]$LogicalMonitors,
        [hashtable]$FriendlyNameMap,
        [hashtable]$DisplayCache
    )

    $entries = @()

    foreach ($display in $Displays) {
        $cacheKey = if ([string]::IsNullOrWhiteSpace($display.DeviceName)) {
            ""
        } else {
            $display.DeviceName.ToUpperInvariant()
        }
        $cachedEntry = if (-not [string]::IsNullOrWhiteSpace($cacheKey) -and $DisplayCache.ContainsKey($cacheKey)) {
            $DisplayCache[$cacheKey]
        } else {
            $null
        }
        $matchingLogicalMonitor = $null
        if ($null -ne $LogicalMonitors) {
            $matchingLogicalMonitor = $LogicalMonitors | Where-Object {
                $_.GdiDeviceName -ieq $display.DeviceName
            } | Select-Object -First 1
        }

        $friendlyName = $null
        $resolvedProductCode = if ($null -ne $matchingLogicalMonitor -and -not [string]::IsNullOrWhiteSpace($matchingLogicalMonitor.DisplayProductCode)) {
            [string]$matchingLogicalMonitor.DisplayProductCode
        } elseif ($null -ne $cachedEntry -and -not [string]::IsNullOrWhiteSpace($cachedEntry.ProductCode)) {
            [string]$cachedEntry.ProductCode
        } else {
            [string]$display.ProductCode
        }
        $productCodeKey = $resolvedProductCode
        if (-not [string]::IsNullOrWhiteSpace($productCodeKey)) {
            $productCodeKey = $productCodeKey.ToUpperInvariant()
        }

        if ($FriendlyNameMap.ContainsKey($productCodeKey)) {
            $friendlyName = $FriendlyNameMap[$productCodeKey]
        } elseif ($null -ne $cachedEntry -and -not [string]::IsNullOrWhiteSpace($cachedEntry.FriendlyName)) {
            $friendlyName = [string]$cachedEntry.FriendlyName
        }

        $displayName = if ([string]::IsNullOrWhiteSpace($friendlyName)) {
            if ($null -ne $cachedEntry -and -not (Test-IsGenericDisplayLabel $cachedEntry.DisplayName)) {
                [string]$cachedEntry.DisplayName
            } elseif ($null -ne $cachedEntry -and -not (Test-IsGenericDisplayLabel $cachedEntry.ProductCode)) {
                [string]$cachedEntry.ProductCode
            } elseif (
                -not [string]::IsNullOrWhiteSpace($display.DeviceString) -and
                $display.DeviceString -ne "AMD Radeon RX 6750 GRE 12GB"
            ) {
                $display.DeviceString
            } elseif ([string]::IsNullOrWhiteSpace($resolvedProductCode)) {
                $display.DeviceString
            } elseif ($resolvedProductCode -like "VEN_*") {
                $display.DeviceString
            } else {
                $resolvedProductCode
            }
        } else {
            $friendlyName
        }

        $resolvedWidth = if ($display.Width -gt 0) {
            [int]$display.Width
        } elseif ($null -ne $cachedEntry -and [int]$cachedEntry.Width -gt 0) {
            [int]$cachedEntry.Width
        } else {
            0
        }
        $resolvedHeight = if ($display.Height -gt 0) {
            [int]$display.Height
        } elseif ($null -ne $cachedEntry -and [int]$cachedEntry.Height -gt 0) {
            [int]$cachedEntry.Height
        } else {
            0
        }
        $resolvedBitsPerPel = if ($display.BitsPerPel -gt 0) {
            [int]$display.BitsPerPel
        } elseif ($null -ne $cachedEntry -and [int]$cachedEntry.BitsPerPel -gt 0) {
            [int]$cachedEntry.BitsPerPel
        } else {
            0
        }
        $resolvedDisplayFrequency = if ($display.DisplayFrequency -gt 0) {
            [int]$display.DisplayFrequency
        } elseif ($null -ne $cachedEntry -and [int]$cachedEntry.DisplayFrequency -gt 0) {
            [int]$cachedEntry.DisplayFrequency
        } else {
            0
        }

        if (
            -not [string]::IsNullOrWhiteSpace($display.DeviceName) -and
            -not (Test-IsGenericDisplayLabel $displayName)
        ) {
            Set-DisplayCacheEntry `
                -DisplayCache $DisplayCache `
                -DeviceName $display.DeviceName `
                -DisplayName $displayName `
                -FriendlyName $friendlyName `
                -ProductCode $resolvedProductCode `
                -Width $resolvedWidth `
                -Height $resolvedHeight `
                -BitsPerPel $resolvedBitsPerPel `
                -DisplayFrequency $resolvedDisplayFrequency
        }

        $entries += [pscustomobject]@{
            Display               = $display
            FriendlyName          = $friendlyName
            DisplayName           = $displayName
            ProductCode           = $resolvedProductCode
            DeviceName            = $display.DeviceName
            Attached              = [bool]$display.Attached
            Primary               = [bool]$display.Primary
            Width                 = $resolvedWidth
            Height                = $resolvedHeight
            BitsPerPel            = $resolvedBitsPerPel
            DisplayFrequency      = $resolvedDisplayFrequency
            NormalizedDisplayName = Normalize-MonitorToken $displayName
            NormalizedProductCode = Normalize-MonitorToken $resolvedProductCode
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
    $displayCache = Read-DisplayCache
    $displays = [NativeDisplayTopology]::GetDisplays()
    $logicalMonitors = [NativeDisplayTopology]::GetLogicalMonitors()
    $displayEntries = Get-DisplayEntries -Displays $displays -LogicalMonitors $logicalMonitors -FriendlyNameMap $friendlyNameMap -DisplayCache $displayCache
    Save-DisplayCache -DisplayCache $displayCache
    $availableMonitors = Get-AvailableMonitorNames -DisplayEntries $displayEntries

    if ($Summary) {
        $summaryEntries = @(
            foreach ($entry in $displayEntries) {
                [pscustomobject]@{
                    DeviceName   = $entry.DeviceName
                    DeviceString = $entry.Display.DeviceString
                    DisplayName  = $entry.DisplayName
                    FriendlyName = $entry.FriendlyName
                    ProductCode  = $entry.ProductCode
                    Attached     = [bool]$entry.Attached
                    Primary      = [bool]$entry.Primary
                    Width        = [int]$entry.Width
                    Height       = [int]$entry.Height
                    BitsPerPel   = [int]$entry.BitsPerPel
                    DisplayFrequency = [int]$entry.DisplayFrequency
                    PositionX    = [int]$entry.Display.PositionX
                    PositionY    = [int]$entry.Display.PositionY
                }
            }
        )
        Write-Output ($summaryEntries | ConvertTo-Json -Compress)
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
            $usePreferredPosition = $PSBoundParameters.ContainsKey("PreferredPositionX") -and $PSBoundParameters.ContainsKey("PreferredPositionY")
            $resolvedPreferredPositionX = if ($null -ne $PreferredPositionX) { [int]$PreferredPositionX } else { 0 }
            $resolvedPreferredPositionY = if ($null -ne $PreferredPositionY) { [int]$PreferredPositionY } else { 0 }
            [NativeDisplayTopology]::AttachDisplayByDeviceName(
                $targetDisplayEntry.DeviceName,
                $resolvedPreferredPositionX,
                $resolvedPreferredPositionY,
                [bool]$usePreferredPosition,
                [int]$targetDisplayEntry.Width,
                [int]$targetDisplayEntry.Height,
                [int]$targetDisplayEntry.BitsPerPel,
                [int]$targetDisplayEntry.DisplayFrequency
            )
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
