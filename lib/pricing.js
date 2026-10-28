// The only place AaaS prices are defined. Clinic, the landing page and the visit kit read this module.
// Both plans include the same agents. The client pays their AI provider directly.

export const SELF_HOSTED_INR = 2999;
export const HOSTED_INR = 4999;
export const SETUP_INR = 9999;

export function inr(n) {
  return '₹' + Number(n).toLocaleString('en-IN');
}

export const PLANS = [
  {
    id: 'self',
    name: 'Self-hosted',
    priceInr: SELF_HOSTED_INR,
    setupInr: SETUP_INR,
    period: 'month',
    blurb: 'Updates and support. Runs on your own server.',
    includes: ['The same agents as Hosted', 'Approvals before anything goes out', 'Updates and support', 'You pay your AI provider directly'],
  },
  {
    id: 'hosted',
    name: 'Hosted',
    priceInr: HOSTED_INR,
    setupInr: 0,
    period: 'month',
    blurb: 'We run it: backups, uptime and updates. No install.',
    includes: ['The same agents as Self-hosted', 'Approvals before anything goes out', 'Backups, uptime and updates', 'You pay your AI provider directly'],
  },
];

export function pricingPublic() {
  return {
    plans: PLANS,
    sameFeatures: 'Both plans include the same agents. You approve anything that would go out.',
    annualNote: `The one-time setup and install fee is ${inr(SETUP_INR)} on Self-hosted. It is waived on an annual plan.`,
    byokNote: 'Both plans use your own AI key (OpenRouter, OpenAI, xAI, Gemini or Anthropic). AI usage is paid by you directly to your provider.',
  };
}

const TOKENS = {
  '{{SELF_INR}}': () => inr(SELF_HOSTED_INR),
  '{{HOSTED_INR}}': () => inr(HOSTED_INR),
  '{{SETUP_INR}}': () => inr(SETUP_INR),
  '{{SELF_AMOUNT}}': () => String(SELF_HOSTED_INR),
  '{{HOSTED_AMOUNT}}': () => String(HOSTED_INR),
  '{{SETUP_AMOUNT}}': () => String(SETUP_INR),
};

export function applyPriceTokens(html) {
  let out = String(html);
  for (const [token, value] of Object.entries(TOKENS)) out = out.split(token).join(value());
  return out;
}
