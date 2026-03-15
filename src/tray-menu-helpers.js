"use strict";

function createWindowsSwitchMenuModel({
  windowsSharedMonitorMissing,
  hasConfigErrors,
  currentOwnerTargetId,
  windowsLabel,
  macLabel,
}) {
  if (windowsSharedMonitorMissing) {
    return [
      {
        kind: "handoffHint",
        label: "共享屏当前已交给另一台电脑，查看交接说明",
        enabled: true,
      },
    ];
  }

  return [
    {
      kind: "target",
      targetId: "windows",
      label: windowsLabel,
      type: "radio",
      checked: currentOwnerTargetId === "windows",
      enabled: !hasConfigErrors,
    },
    {
      kind: "target",
      targetId: "mac",
      label: macLabel,
      type: "radio",
      checked: currentOwnerTargetId === "mac",
      enabled: !hasConfigErrors,
    },
  ];
}

function createWindowsSharedMonitorTransferHint({ monitorName, message }) {
  const resolvedMonitorName = monitorName || "共享屏";
  return {
    message: `${resolvedMonitorName} 当前已交给另一台电脑`,
    detail: [
      message || `${resolvedMonitorName} 当前不由 Windows 持有，请到 Mac 端或显示器菜单切回。`,
      "",
      "现在的交接规则是：谁当前拥有这块共享屏，谁负责把它交出去。",
      "如果它已经切到 Mac，请在 Mac 端菜单栏或显示器菜单里把它切回 Windows。",
    ].join("\n"),
  };
}

module.exports = {
  createWindowsSharedMonitorTransferHint,
  createWindowsSwitchMenuModel,
};
