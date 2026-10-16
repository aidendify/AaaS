// Factory tools (filled in by the factory-tools change). Until then no agent gets extra tools.
export function factoryTools() { return []; }
export async function runFactoryApproval() { throw new Error('Factory tools are not installed.'); }
