import { redirect } from "next/navigation";
import { loadDashboardData, loadRepositories } from "./data";

export default async function HomePage() {
  const [dashboard, repositories] = await Promise.all([loadDashboardData(), loadRepositories()]);
  if (dashboard.records.length === 0 || repositories.repositories.length === 0) {
    redirect("/onboarding");
  }
  redirect("/dashboard");
}
