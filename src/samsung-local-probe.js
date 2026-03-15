const { execFile } = require("node:child_process");
const dgram = require("node:dgram");
const fs = require("node:fs");
const http = require("node:http");
const https = require("node:https");
const os = require("node:os");
const path = require("node:path");

const SSDP_MULTICAST_ADDRESS = "239.255.255.250";
const SSDP_PORT = 1900;
const DEFAULT_SSDP_TIMEOUT_MS = 1800;
const NETWORK_REQUEST_TIMEOUT_MS = 1200;
const MAX_DISCOVERED_DEVICES = 6;

function normalizeText(value) {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeToken(value) {
  return normalizeText(value).toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function execCommand(file, args, timeoutMs = 6000) {
  return new Promise((resolve, reject) => {
    execFile(file, args, { timeout: timeoutMs, windowsHide: true }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error([stdout, stderr, error.message].filter(Boolean).join("\n").trim()));
        return;
      }

      resolve([stdout, stderr].filter(Boolean).join("\n"));
    });
  });
}

function requestText(urlString, timeoutMs = NETWORK_REQUEST_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    let parsedUrl;

    try {
      parsedUrl = new URL(urlString);
    } catch (error) {
      reject(error);
      return;
    }

    const client = parsedUrl.protocol === "https:" ? https : http;
    const request = client.request(
      parsedUrl,
      {
        method: "GET",
        timeout: timeoutMs,
        headers: {
          Accept: "application/xml, text/xml, */*",
        },
      },
      (response) => {
        let body = "";
        response.setEncoding("utf8");
        response.on("data", (chunk) => {
          body += chunk;
        });
        response.on("end", () => {
          if ((response.statusCode || 0) < 200 || (response.statusCode || 0) >= 300) {
            reject(new Error(`HTTP ${response.statusCode || 0}`));
            return;
          }

          resolve(body);
        });
      }
    );

    request.on("timeout", () => {
      request.destroy(new Error("request timed out"));
    });
    request.on("error", reject);
    request.end();
  });
}

function extractXmlTagValue(xml, tagName) {
  if (!normalizeText(xml)) {
    return "";
  }

  const match = new RegExp(`<${tagName}>([\\s\\S]*?)<\\/${tagName}>`, "i").exec(xml);
  if (!match) {
    return "";
  }

  return normalizeText(match[1].replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1"));
}

function extractServiceTypes(xml) {
  if (!normalizeText(xml)) {
    return [];
  }

  const matches = xml.match(/<serviceType>([\s\S]*?)<\/serviceType>/gi) || [];
  const values = matches
    .map((entry) => normalizeText(entry.replace(/<\/?serviceType>/gi, "")))
    .filter(Boolean);
  return Array.from(new Set(values));
}

function parseSsdpHeaders(packetText) {
  const headers = {};

  for (const line of packetText.split(/\r?\n/)) {
    const separatorIndex = line.indexOf(":");
    if (separatorIndex <= 0) {
      continue;
    }

    const key = line.slice(0, separatorIndex).trim().toLowerCase();
    const value = line.slice(separatorIndex + 1).trim();
    if (key) {
      headers[key] = value;
    }
  }

  return headers;
}

async function discoverSsdpResponses(timeoutMs) {
  return new Promise((resolve) => {
    const socket = dgram.createSocket({ type: "udp4", reuseAddr: true });
    const discovered = [];
    let finished = false;

    const finish = () => {
      if (finished) {
        return;
      }

      finished = true;
      try {
        socket.close();
      } catch {
        // Ignore socket close failures during shutdown.
      }
      resolve(discovered);
    };

    socket.on("message", (buffer, remoteInfo) => {
      const packetText = buffer.toString("utf8");
      const headers = parseSsdpHeaders(packetText);
      discovered.push({
        address: remoteInfo.address,
        headers,
        packetText,
      });
    });

    socket.on("error", finish);
    socket.bind(0, () => {
      socket.setBroadcast(true);
      socket.setMulticastTTL(2);

      const searchTargets = ["ssdp:all", "upnp:rootdevice"];
      for (const searchTarget of searchTargets) {
        const payload = [
          "M-SEARCH * HTTP/1.1",
          `HOST:${SSDP_MULTICAST_ADDRESS}:${SSDP_PORT}`,
          'MAN:"ssdp:discover"',
          "MX:1",
          `ST:${searchTarget}`,
          "",
          "",
        ].join("\r\n");

        socket.send(Buffer.from(payload), SSDP_PORT, SSDP_MULTICAST_ADDRESS);
      }
    });

    setTimeout(finish, timeoutMs);
  });
}

function looksLikeSamsungDevice(fields, monitorName) {
  const combined = fields.filter(Boolean).join(" ").toLowerCase();
  const monitorToken = normalizeToken(monitorName);

  if (combined.includes("samsung")) {
    return true;
  }

  if (/\bsmart monitor\b|\bodyssey\b|\bg70\b|\bg72\b|\bg7\b/i.test(combined)) {
    return true;
  }

  if (monitorToken && normalizeToken(combined).includes(monitorToken)) {
    return true;
  }

  return false;
}

async function enrichNetworkDevice(entry, monitorName) {
  const location = normalizeText(entry.headers.location);
  let descriptionXml = "";
  let descriptionError = "";

  if (location) {
    try {
      descriptionXml = await requestText(location);
    } catch (error) {
      descriptionError = normalizeText(error.message);
    }
  }

  const manufacturer = extractXmlTagValue(descriptionXml, "manufacturer");
  const friendlyName = extractXmlTagValue(descriptionXml, "friendlyName");
  const modelName = extractXmlTagValue(descriptionXml, "modelName");
  const deviceType = extractXmlTagValue(descriptionXml, "deviceType");
  const serviceTypes = extractServiceTypes(descriptionXml);
  const matchedMonitor =
    Boolean(normalizeToken(monitorName)) &&
    [friendlyName, modelName, deviceType, entry.headers.usn, entry.headers.server].some((value) => {
      const token = normalizeToken(value);
      const monitorToken = normalizeToken(monitorName);
      return token && monitorToken && (token.includes(monitorToken) || monitorToken.includes(token));
    });

  return {
    address: entry.address,
    location,
    manufacturer,
    friendlyName,
    modelName,
    deviceType,
    server: normalizeText(entry.headers.server),
    usn: normalizeText(entry.headers.usn),
    serviceTypes,
    matchedMonitor,
    descriptionError,
  };
}

async function detectSamsungNetworkDevices(monitorName, timeoutMs = DEFAULT_SSDP_TIMEOUT_MS) {
  try {
    const responses = await discoverSsdpResponses(timeoutMs);
    const uniqueEntries = new Map();

    for (const response of responses) {
      const key = [
        normalizeText(response.headers.location),
        normalizeText(response.headers.usn),
        normalizeText(response.address),
      ]
        .filter(Boolean)
        .join("|");
      if (!key || uniqueEntries.has(key)) {
        continue;
      }
      uniqueEntries.set(key, response);
    }

    const enrichedEntries = [];
    for (const entry of uniqueEntries.values()) {
      if (enrichedEntries.length >= MAX_DISCOVERED_DEVICES) {
        break;
      }

      const enrichedEntry = await enrichNetworkDevice(entry, monitorName);
      const looksSamsung = looksLikeSamsungDevice(
        [
          enrichedEntry.manufacturer,
          enrichedEntry.friendlyName,
          enrichedEntry.modelName,
          enrichedEntry.deviceType,
          enrichedEntry.server,
          enrichedEntry.usn,
        ],
        monitorName
      );

      if (looksSamsung) {
        enrichedEntries.push(enrichedEntry);
      }
    }

    if (enrichedEntries.length === 0) {
      return {
        status: "missing",
        devices: [],
        message: "当前局域网里没有发现可归到三星 Smart Monitor 的 SSDP/UPnP 设备。",
      };
    }

    return {
      status: "discovered",
      devices: enrichedEntries,
      message: "已在本地网络里发现三星显示设备，可继续沿这条本地私有链路抓协议。",
    };
  } catch (error) {
    return {
      status: "error",
      devices: [],
      message: normalizeText(error.message) || "SSDP/UPnP 探测失败。",
    };
  }
}

async function detectMacUsbEvidence() {
  try {
    const output = await execCommand("system_profiler", ["SPUSBDataType"], 12000);
    const evidenceLines = output
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => /samsung|odyssey|smart monitor|display|monitor/i.test(line))
      .slice(0, 10);

    if (evidenceLines.length === 0) {
      return {
        status: "missing",
        lines: [],
        message: "本机当前没有看到带三星标识的 USB/HID 设备；如果要走 USB 私有链路，这通常意味着 USB-B 上行还没在当前主机侧生效。",
      };
    }

    return {
      status: "detected",
      lines: evidenceLines,
      message: "本机已经看到了带三星标识的 USB 证据，可继续沿 USB 本地链路排查。",
    };
  } catch (error) {
    return {
      status: "error",
      lines: [],
      message: normalizeText(error.message) || "USB 设备检测失败。",
    };
  }
}

async function detectWindowsUsbEvidence() {
  const script = [
    "$devices = Get-PnpDevice -PresentOnly -ErrorAction SilentlyContinue |",
    "  Where-Object {",
    "    ($_.FriendlyName -match 'Samsung|Odyssey|Smart Monitor|Display|Monitor') -or",
    "    ($_.InstanceId -match 'SAMSUNG')",
    "  } |",
    "  Select-Object -First 10 -ExpandProperty FriendlyName",
    "if ($devices) { $devices }",
  ].join(" ");

  try {
    const output = await execCommand("powershell.exe", ["-NoProfile", "-Command", script], 8000);
    const lines = output
      .split(/\r?\n/)
      .map((line) => normalizeText(line))
      .filter(Boolean);

    if (lines.length === 0) {
      return {
        status: "missing",
        lines: [],
        message: "Windows 当前没有枚举到带三星标识的 USB 设备；如果要走 USB 私有链路，这通常意味着 USB-B 上行还没在当前主机侧生效。",
      };
    }

    return {
      status: "detected",
      lines,
      message: "Windows 当前已经枚举到带三星标识的 USB 设备，可继续沿 USB 本地链路排查。",
    };
  } catch (error) {
    return {
      status: "error",
      lines: [],
      message: normalizeText(error.message) || "USB 设备检测失败。",
    };
  }
}

async function detectUsbEvidence() {
  if (process.platform === "darwin") {
    return detectMacUsbEvidence();
  }

  if (process.platform === "win32") {
    return detectWindowsUsbEvidence();
  }

  return {
    status: "unsupported",
    lines: [],
    message: "当前平台没有实现三星 USB 本地链路检测。",
  };
}

function buildSoftwareCandidates() {
  if (process.platform === "darwin") {
    return [
      {
        name: "Easy Setting Box",
        path: "/Applications/EasySettingBox.app",
      },
      {
        name: "Easy Setting Box",
        path: path.join(os.homedir(), "Applications", "EasySettingBox.app"),
      },
    ];
  }

  if (process.platform === "win32") {
    const roots = [
      process.env.ProgramFiles,
      process.env["ProgramFiles(x86)"],
      process.env.LOCALAPPDATA,
    ].filter(Boolean);

    const entries = [];
    for (const root of roots) {
      entries.push({
        name: "Easy Setting Box",
        path: path.join(root, "Samsung", "Easy Setting Box", "Easy Setting Box.exe"),
      });
      entries.push({
        name: "Samsung Display Manager",
        path: path.join(root, "Samsung", "Samsung Display Manager", "Samsung Display Manager.exe"),
      });
    }
    return entries;
  }

  return [];
}

async function detectOfficialSamsungSoftware() {
  const candidates = buildSoftwareCandidates();
  const detected = candidates.filter((candidate, index, array) => {
    const firstIndex = array.findIndex((item) => item.path === candidate.path);
    return firstIndex === index && fs.existsSync(candidate.path);
  });

  if (detected.length === 0) {
    return {
      status: "missing",
      items: [],
      message: "本机没找到三星官方控制软件；如果后面要复用官方链路，至少需要先有 Easy Setting Box 这类官方入口。",
    };
  }

  return {
    status: "installed",
    items: detected,
    message: `本机已找到三星官方软件：${detected.map((item) => item.name).join("、")}。`,
  };
}

function buildOverallProbeStatus(officialSoftware, usbEvidence, networkDiscovery) {
  const hasOfficialSoftware = officialSoftware.status === "installed";
  const hasUsbEvidence = usbEvidence.status === "detected";
  const hasSamsungNetworkDevice = networkDiscovery.status === "discovered";
  const hasMatchedDevice = networkDiscovery.devices.some((device) => device.matchedMonitor);

  if (hasOfficialSoftware && (hasUsbEvidence || hasSamsungNetworkDevice)) {
    return {
      status: "ready",
      summary: hasMatchedDevice
        ? "本机已经具备三星本地私有链路的关键入口。"
        : "本机已经发现三星本地私有链路入口，但还没把它和当前共享屏精准对上。",
      recommendation: hasMatchedDevice
        ? "可以继续沿官方 Easy Setting Box 的本地鉴权 / socket 协议做抓包和逆向，不必再只盯着 DDC。"
        : "下一步应该把发现到的三星设备和当前这块共享屏对上，再继续抓协议。",
    };
  }

  if (hasSamsungNetworkDevice || hasUsbEvidence || hasOfficialSoftware) {
    return {
      status: "partial",
      summary: "本机只满足了三星本地私有链路的一部分前提。",
      recommendation: "当前可以继续排查官方软件、USB-B 上行和 Smart Monitor 网络发现，但还不够支撑把它作为稳定切换后端。",
    };
  }

  return {
    status: "missing",
    summary: "本机当前没有检测到可用的三星本地私有入口。",
    recommendation: "这台机器当前更现实的本地切换路径仍然是 DDC/CI；若要走三星私有协议，需要先让 USB-B 上行或 Smart Monitor 网络发现至少出现一条本地入口。",
  };
}

async function probeSamsungLocalControl({ monitorName = "" } = {}) {
  const [officialSoftware, usbEvidence, networkDiscovery] = await Promise.all([
    detectOfficialSamsungSoftware(),
    detectUsbEvidence(),
    detectSamsungNetworkDevices(monitorName),
  ]);
  const overall = buildOverallProbeStatus(officialSoftware, usbEvidence, networkDiscovery);

  return {
    platform: process.platform,
    monitorName: normalizeText(monitorName),
    officialSoftware,
    usbEvidence,
    networkDiscovery,
    status: overall.status,
    summary: overall.summary,
    recommendation: overall.recommendation,
    updatedAt: new Date().toISOString(),
  };
}

module.exports = {
  probeSamsungLocalControl,
};
