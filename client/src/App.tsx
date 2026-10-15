import { QueryClientProvider } from "@tanstack/react-query";
import { Redirect, Route, Switch, useLocation } from "wouter";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import { ThemeProvider } from "@/components/ThemeProvider";
import { AppLayout } from "@/components/AppLayout";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import { Loading } from "@/components/common";
import { queryClient } from "@/lib/api";
import { AuthProvider, useAuth, type Role } from "@/lib/auth";
import { I18nProvider } from "@/lib/i18n";
import Login from "@/pages/Login";
import Dashboard from "@/pages/Dashboard";
import POS from "@/pages/POS";
import Sales from "@/pages/Sales";
import SaleDetail from "@/pages/SaleDetail";
import Products from "@/pages/Products";
import ProductDetail from "@/pages/ProductDetail";
import Motorcycles from "@/pages/Motorcycles";
import Stock from "@/pages/Stock";
import Containers from "@/pages/Containers";
import ContainerDetail from "@/pages/ContainerDetail";
import Expenses from "@/pages/Expenses";
import Money from "@/pages/Money";
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
import Inventory from "@/pages/Inventory";
import StockImport from "@/pages/StockImport";
import SalesTools from "@/pages/SalesTools";
import Analytics from "@/pages/Analytics";

function Guard({ roles, children }: { roles: Role[]; children: React.ReactNode }) {
  const { can, user } = useAuth();
  if (!can(...roles)) return <Redirect to={user?.role === "cashier" ? "/pos" : "/"} />;
  return <>{children}</>;
}

function Routes() {
  const { user, loading } = useAuth();
  const [location] = useLocation();
  if (loading) return <Loading />;
  if (!user) return <Login />;
  const R = (path: string, roles: Role[], C: React.ComponentType) => (
    <Route path={path}>
      <Guard roles={roles}>
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
        {R("/stock/import", ["manager"], StockImport)}
        {R("/stock", ["manager", "partner"], Stock)}
        {R("/inventory", ["manager", "partner"], Inventory)}
        {R("/daybook", ["manager", "partner"], Daybook)}
        {R("/vouchers/:id", ["manager", "partner"], VoucherPrint)}
        {R("/vouchers", ["manager", "partner"], Vouchers)}
        {R("/optional-vouchers", ["manager", "partner"], OptionalVouchers)}
        {R("/accounts", ["manager", "partner"], Accounts)}
        {R("/payroll", ["manager", "partner"], Payroll)}
        {R("/sales-tools", ["manager", "cashier", "partner"], SalesTools)}
        {R("/analytics", ["manager", "partner"], Analytics)}
        {R("/containers", ["manager", "partner"], Containers)}
        {R("/containers/:id", ["manager", "partner"], ContainerDetail)}
        {R("/expenses", ["manager", "partner"], Expenses)}
        {R("/money", ["manager", "partner"], Money)}
        {R("/contacts", ["manager", "cashier", "partner"], Contacts)}
        {R("/contacts/:id", ["manager", "cashier", "partner"], ContactDetail)}
        {R("/partners", ["manager", "partner"], Partners)}
        {R("/reports", ["manager", "partner"], Reports)}
        {R("/settings", [], Settings)}
        <Route>
          <Redirect to="/" />
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
