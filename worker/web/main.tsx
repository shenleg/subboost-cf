// 挂载 Worker 的浏览器路由和原版自托管界面骨架。
import { lazy, Suspense } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, Route, Routes } from "react-router";
import "@subboost/ui/styles/globals.css";
import { Footer } from "@subboost/ui/components/layout/footer";
import { MobileNav } from "@subboost/ui/components/layout/mobile-nav";
import { ScrollLockStabilizer } from "@subboost/ui/components/layout/scroll-lock-stabilizer";
import { ConfirmDialogHost } from "@subboost/ui/components/ui/confirm-dialog";
import { Toaster } from "@subboost/ui/components/ui/toaster";
import { applyTheme, getSystemTheme, readStoredTheme } from "@subboost/ui/theme/theme";
import { LocalHeader } from "../../local/src/components/local-header";
import { version } from "../../package.json";
import { useWorkerAuthState } from "./auth-state";

const HomePage = lazy(() => import("../../local/app/page"));
const DashboardPage = lazy(() => import("./dashboard"));
const TemplatesPage = lazy(() => import("../../local/app/templates/page"));
const LoginPage = lazy(() => import("./login"));
const SettingsPage = lazy(() => import("./settings"));

function Home() {
  const auth = useWorkerAuthState();
  return (
    <>
      {auth.status === "unconfigured" && (
        <p role="alert" className="mx-auto mt-4 w-fit rounded-lg border border-amber-400/25 bg-amber-400/10 px-4 py-2 text-sm text-amber-400">
          {auth.message}
        </p>
      )}
      <HomePage />
    </>
  );
}

function App() {
  return (
    <BrowserRouter>
      <ScrollLockStabilizer />
      <div className="min-h-screen bg-gradient-radial flex flex-col">
        <LocalHeader />
        <main className="flex-1 pb-16 md:pb-0">
          <Suspense fallback={<p className="p-6 text-center" role="status">正在加载…</p>}>
            <Routes>
              <Route path="/" element={<Home />} />
              <Route path="/dashboard" element={<DashboardPage />} />
              <Route path="/templates" element={<TemplatesPage />} />
              <Route path="/login" element={<LoginPage />} />
              <Route path="/dashboard/settings" element={<SettingsPage />} />
              <Route path="*" element={<h1 className="p-8 text-center text-xl">页面不存在</h1>} />
            </Routes>
          </Suspense>
        </main>
        <Footer mode="local" buildVersion={version} />
        <MobileNav mode="local" />
      </div>
      <Toaster />
      <ConfirmDialogHost />
    </BrowserRouter>
  );
}

applyTheme(readStoredTheme() ?? getSystemTheme());
createRoot(document.getElementById("root")!).render(<App />);
