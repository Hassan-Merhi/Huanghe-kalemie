import { QueryClientProvider } from "@tanstack/react-query";
import { Link, Redirect, Route, Switch, useLocation } from "wouter";
import { Button } from "@/components/ui/button";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import { ThemeProvider } from "@/components/ThemeProvider";
import { AppLayout } from "@/components/AppLayout";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import { Loading } from "@/components/common";
import { queryClient } from "@/lib/api";
import { AuthProvider, useAuth, type Role } from "@/lib/auth";
import { I18nProvider, useT } from "@/lib/i18n";
import Login from "@/pages/Login";
import Dashboard from "@/pages/Dashboard";
import POS from "@/pages/POS";
import Sales from "@/pages/Sales";
import SaleDetail from "@/pages/SaleDetail";
import Products from "@/pages/Products";
import ProductDetail from "@/pages/ProductDetail";
import Motorcycles from "@/pages/Motorcycles";
import Containers from "@/pages/Containers";
import ContainerDetail from "@/pages/ContainerDetail";
import Contacts from "@/pages/Contacts";
import ContactDetail from "@/pages/ContactDetail";
import Partners from "@/pages/Partners";
import Reports from "@/pages/Reports";
import Settings from "@/pages/Settings";
import Vouchers from "@/pages/Vouchers";
import VoucherPrint from "@/pages/VoucherPrint";
import OptionalVouchers from "@/pages/OptionalVouchers";
import Daybook from "@/pages/Daybook";
import Accounts from "@/pages/Accounts";
import Payroll from "@/pages/Payroll";
import InventoryLocations from "@/pages/InventoryLocations";
import SalesTools from "@/pages/SalesTools";
import Analytics from "@/pages/Analytics";

/** Where each role starts: the till for cashiers, the dashboard for everyone else. */
const homeOf = (role?: Role) => (role === "cashier" ? "/pos" : "/");

function Blocked({ forbidden }: { forbidden?: boolean }) {
  const { user } = useAuth();
  const t = useT();
  return (
    <div className="mx-auto max-w-md py-16 text-center">
      <h1 className="text-xl font-semibold">{forbidden ? t("Not available for your role", "Page non accessible à votre rôle") : t("Page not found", "Page introuvable")}</h1>
      <p className="mt-2 text-sm text-muted-foreground">
        {forbidden
          ? t("Ask the owner if you need this page.", "Demandez au propriétaire si vous avez besoin de cette page.")
          : t("The link may be old or mistyped.", "Le lien est peut-être ancien ou mal saisi.")}
      </p>
      <Button asChild className="mt-6">
        <Link href={homeOf(user?.role)}>{user?.role === "cashier" ? t("Go to the till", "Aller à la caisse") : t("Go to the dashboard", "Aller au tableau de bord")}</Link>
      </Button>
    </div>
  );
}

function Guard({ path, roles, children }: { path: string; roles: Role[]; children: React.ReactNode }) {
  const { can, user } = useAuth();
  if (!can(...roles)) return path === "/" ? <Redirect to={homeOf(user?.role)} /> : <Blocked forbidden />;
  return <>{children}</>;
}

/** An old link to a removed page: on to the page that took its place, or home for a role that cannot see it. */
function OldLink({ to, roles }: { to: string; roles: Role[] }) {
  const { can, user } = useAuth();
  return <Redirect to={can(...roles) ? to : homeOf(user?.role)} />;
}

function Routes() {
  const { user, loading } = useAuth();
  const [location] = useLocation();
  if (loading) return <Loading />;
  if (!user) return <Login />;
  const R = (path: string, roles: Role[], C: React.ComponentType) => (
    <Route path={path}>
      <Guard path={path} roles={roles}>
        <C />
      </Guard>
    </Route>
  );
  return (
    <AppLayout>
      <ErrorBoundary key={location}>
      <Switch>
        {R("/", ["manager", "partner"], Dashboard)}
        {R("/pos", ["manager", "cashier"], POS)}
        {R("/sales", ["manager", "cashier", "partner"], Sales)}
        {R("/sales/:id", ["manager", "cashier", "partner"], SaleDetail)}
        {R("/products", ["manager", "cashier", "partner"], Products)}
        {R("/products/:id", ["manager", "cashier", "partner"], ProductDetail)}
        {R("/motorcycles", ["manager", "cashier", "partner"], Motorcycles)}
        <Route path="/stock/import"><OldLink to="/products?import=1" roles={["manager"]} /></Route>
        <Route path="/stock"><OldLink to="/products" roles={["manager", "partner"]} /></Route>
        {R("/inventory", ["manager", "partner"], InventoryLocations)}
        {R("/daybook", ["manager", "partner"], Daybook)}
        {R("/vouchers/:id", ["manager", "partner"], VoucherPrint)}
        {R("/vouchers", ["manager", "partner"], Vouchers)}
        {R("/optional-vouchers", ["manager", "partner"], OptionalVouchers)}
        {R("/accounts", ["manager", "partner"], Accounts)}
        {R("/payroll", ["manager", "partner"], Payroll)}
        {R("/payroll/employees/:id", ["manager", "partner"], ContactDetail)}
        {R("/sales-tools", ["manager", "cashier", "partner"], SalesTools)}
        {R("/analytics", ["manager", "partner"], Analytics)}
        {R("/containers", ["manager", "partner"], Containers)}
        {R("/containers/:id", ["manager", "partner"], ContainerDetail)}
        {/* Pages that were removed: their work is done in Vouchers, Accounts and the dashboard. */}
        <Route path="/money"><OldLink to="/accounts" roles={["manager", "partner"]} /></Route>
        <Route path="/expenses"><OldLink to="/vouchers?tab=payment&line=account" roles={["manager", "partner"]} /></Route>
        {R("/contacts", ["manager", "cashier", "partner"], Contacts)}
        {R("/contacts/:id", ["manager", "cashier", "partner"], ContactDetail)}
        {R("/partners", ["manager", "partner"], Partners)}
        {R("/reports", ["manager", "partner"], Reports)}
        {R("/settings", [], Settings)}
        <Route>
          <Blocked />
        </Route>
      </Switch>
      </ErrorBoundary>
    </AppLayout>
  );
}

export default function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <I18nProvider>
        <ThemeProvider>
          <TooltipProvider>
            <AuthProvider>
              <Routes />
              <Toaster />
            </AuthProvider>
          </TooltipProvider>
        </ThemeProvider>
      </I18nProvider>
    </QueryClientProvider>
  );
}
