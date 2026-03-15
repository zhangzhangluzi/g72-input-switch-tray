"use strict";

function normalizeText(value) {
  return String(value ?? "").trim();
}

function normalizeMonitorToken(value) {
  return normalizeText(value).replace(/[^0-9A-Za-z]+/g, "").toLowerCase();
}

function doesMonitorListContainConfiguredMonitor(monitorNames, configuredName) {
  const requestedName = normalizeText(configuredName);
  if (!requestedName) {
    return false;
  }

  const requestedToken = normalizeMonitorToken(requestedName);
  const exactMatches = monitorNames.filter(
    (name) => normalizeText(name).toLowerCase() === requestedName.toLowerCase()
  );
  if (exactMatches.length === 1) {
    return true;
  }

  if (!requestedToken) {
    return false;
  }

  const normalizedMatches = monitorNames.filter(
    (name) => normalizeMonitorToken(name) === requestedToken
  );
  if (normalizedMatches.length === 1) {
    return true;
  }

  const partialMatches = monitorNames.filter((name) => {
    const candidateToken = normalizeMonitorToken(name);
    return (
      candidateToken &&
      (candidateToken.includes(requestedToken) || requestedToken.includes(candidateToken))
    );
  });

  return partialMatches.length === 1;
}

module.exports = {
  doesMonitorListContainConfiguredMonitor,
  normalizeMonitorToken,
  normalizeText,
};
