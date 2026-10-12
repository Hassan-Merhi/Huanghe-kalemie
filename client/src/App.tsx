import { QueryClientProvider } from "@tanstack/react-query";
import { Redirect, Route, Switch } from "wouter";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import { ThemeProvider } from "@/components/ThemeProvider";
import { AppLayout } from "@/components/AppLayout";
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

function Guard({ roles, children }: { roles: Role[]; children: React.ReactNode }) {
  const { can, user } = useAuth();
  if (!can(...roles)) return <Redirect to={user?.role === "cashier" ? "/pos" : "/"} />;
  return <>{children}</>;
}

function Routes() {
  const { user, loading } = useAuth();
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
      <Switch>
        {R("/", ["manager", "partner"], Dashboard)}
        {R("/pos", ["manager", "cashier"], POS)}
        {R("/sales", ["manager", "cashier", "partner"], Sales)}
        {R("/sales/:id", ["manager", "cashier", "partner"], SaleDetail)}
        {R("/products", ["manager", "cashier", "partner"], Products)}
        {R("/products/:id", ["manager", "cashier", "partner"], ProductDetail)}
        {R("/motorcycles", ["manager", "cashier", "partner"], Motorcycles)}
        {R("/stock", ["manager", "partner"], Stock)}
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
