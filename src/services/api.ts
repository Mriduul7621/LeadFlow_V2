// This is a placeholder service. In a real app, you'd fetch from your GAS endpoint.
// For now, it provides mock data or logic.
//
// NOTE: no server secret (e.g. a Gemini/API key) is imported or referenced
// here. Any future AI call must go through a server-side API boundary and
// never embed the key in the browser bundle (see docs/PRODUCTION_READINESS.md).

export const fetchLeads = async (filters: any) => {
  // Simulate API delay
  await new Promise(resolve => setTimeout(resolve, 800));
  // In production: const response = await fetch(`${process.env.VITE_GAS_API_URL}?action=getLeads&...`);
  return [];
};

export const fetchDashboardStats = async () => {
  await new Promise(resolve => setTimeout(resolve, 500));
  return {
    newLeads: 440,
    agentResponses: 12,
    pipelineVolume: 709500,
    immediateAlerts: 4,
  };
};
