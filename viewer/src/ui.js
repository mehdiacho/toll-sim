export const DISCLAIMER =
  "Independent demo with synthetic data. Not affiliated with the Government of Botswana, any ministry, toll operator or payment provider.";

export const DASHBOARD_URL = `${import.meta.env.BASE_URL}live/dashboard`;

export function footerHtml() {
  return `<span class="disclaimer">${DISCLAIMER}</span>`;
}

export function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

/** 100 thebe = 1 pula. */
export function money(thebe) {
  const p = (thebe ?? 0) / 100;
  return `P ${p.toLocaleString("en-GB", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/** Botswana plates are stored without spaces: B123ABC -> "B 123 ABC". */
export function plateHtml(plate) {
  if (!plate) return `<span class="plate unread">no read</span>`;
  const m = /^([A-Z])(\d{3})([A-Z]{3})$/.exec(plate);
  const text = m ? `${m[1]} ${m[2]} ${m[3]}` : plate;
  return `<span class="plate">${esc(text)}</span>`;
}

export const STATUS_LABEL = {
  charged: "Paid",
  paid: "Paid",
  unpaid: "Unpaid",
  violation: "Violation",
  review: "Review",
  waived: "Waived",
  refunded: "Refunded",
};

export const REASON_LABEL = {
  insufficient_funds: "low balance",
  unregistered_vehicle: "not registered",
  account_inactive: "account inactive",
};
