import { useEffect, useState } from "react";

import { fetchSummaryData, type SummaryData } from "@/lib/data/summary-data";
import { buildTelcoDataset, type TelcoDataset } from "@/lib/data/telco-adapter";
import { TelcoDashboard } from "@/components/telco/telco-dashboard";
import { RefreshIcon } from "@/components/dashboard/icons";

// Data is fetched client-side (in the browser) straight from Google Sheets'
// public CSV export, which reflects CORS for any origin.
export function App() {
  const [dataset, setDataset] = useState<TelcoDataset | null>(null);
  const [raw, setRaw] = useState<SummaryData | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [refreshError, setRefreshError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetchSummaryData()
      .then((result) => {
        if (cancelled) return;
        setRaw(result);
        setDataset(buildTelcoDataset(result));
      })
      .catch((err) => {
        if (!cancelled) setLoadError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  async function handleRefresh() {
    setRefreshing(true);
    setRefreshError(null);
    try {
      const fresh = await fetchSummaryData();
      setRaw(fresh);
      setDataset(buildTelcoDataset(fresh));
    } catch (err) {
      setRefreshError(err instanceof Error ? err.message : "Could not refresh the data.");
    } finally {
      setRefreshing(false);
    }
  }

  if (loadError) {
    return (
      <div style={{ display: "flex", minHeight: "100vh", alignItems: "center", justifyContent: "center", background: "#EAEEF3", padding: 24 }}>
        <div style={{ maxWidth: 640 }}>
          <h1 style={{ color: "#C32A2A", fontSize: 20, fontWeight: 700, marginBottom: 8 }}>Could not load the dashboard data</h1>
          <pre style={{ overflow: "auto", whiteSpace: "pre-wrap", borderRadius: 8, border: "1px solid #E3E9EF", background: "#fff", padding: 16, fontSize: 12, color: "#67788A" }}>{loadError}</pre>
        </div>
      </div>
    );
  }

  if (!dataset || !raw) {
    return (
      <div style={{ display: "flex", minHeight: "100vh", alignItems: "center", justifyContent: "center", background: "#EAEEF3" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 12, fontSize: 14, color: "#67788A" }}>
          <RefreshIcon className="icon-md spin" />
          Loading live data from Google Sheets…
        </div>
      </div>
    );
  }

  return (
    <TelcoDashboard
      data={dataset}
      lastUpdated={raw.fetchedAt}
      refreshing={refreshing}
      refreshError={refreshError}
      onRefresh={handleRefresh}
    />
  );
}
