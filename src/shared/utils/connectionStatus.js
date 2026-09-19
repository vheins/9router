export function getStatusVariant(isActive, effectiveStatus, isBanned = false) {
  if (isBanned === true) return "warning";
  if (isActive === false) return "default";
  if (effectiveStatus === "active" || effectiveStatus === "success") return "success";
  if (effectiveStatus === "error" || effectiveStatus === "expired" || effectiveStatus === "unavailable") return "error";
  return "default";
}
