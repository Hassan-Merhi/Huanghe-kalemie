import type { ReactNode } from "react";
import { Link, useLocation } from "wouter";
import {
  BarChart3,
  Boxes,
  Container,
  HandCoins,
  LayoutDashboard,
  LogOut,
  Package,
  Receipt,
  Settings as SettingsIcon,
  ShoppingCart,
  Users,
  Wallet,
  Bike,
  PieChart,
  BookOpen,
  FileText,
  FilePen,
  Layers,
  FileUp,
  LayoutGrid,
  Landmark,
  UserCheck,
  TrendingUp,
} from "lucide-react";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarInset,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
  SidebarTrigger,
  useSidebar,
} from "@/components/ui/sidebar";
import { Button } from "@/components/ui/button";
import { useAuth, type Role } from "@/lib/auth";
import { useI18n } from "@/lib/i18n";
import { ThemeToggle } from "@/components/ThemeProvider";
import { api, queryClient } from "@/lib/api";

interface NavItem {
  href: string;
  en: string;
  fr: string;
  icon: typeof LayoutDashboard;
  roles: Role[];
  /** Only highlight on this exact path (not its sub-pages). */
  exact?: boolean;
}

const NAV: { en: string; fr: string; items: NavItem[] }[] = [
  {
    en: "Shop",
    fr: "Boutique",
    items: [
      { href: "/", en: "Dashboard", fr: "Tableau de bord", icon: LayoutDashboard, roles: ["manager", "partner"] },
      { href: "/daybook", en: "Daybook", fr: "Journal du jour", icon: BookOpen, roles: ["manager", "partner"] },
      { href: "/vouchers", en: "Vouchers", fr: "Pièces", icon: FileText, roles: ["manager", "partner"] },
      { href: "/optional-vouchers", en: "Optional vouchers", fr: "Pièces facultatives", icon: FilePen, roles: ["manager", "partner"] },
    ],
  },
  {
    en: "Inventory",
    fr: "Inventaire",
    items: [
      { href: "/inventory", en: "Inventory", fr: "Inventaire", icon: Layers, roles: ["manager", "partner"] },
      { href: "/stock", en: "Stock", fr: "Stock", icon: Boxes, roles: ["manager", "partner"], exact: true },
      { href: "/products", en: "Items", fr: "Articles", icon: Package, roles: ["manager", "cashier", "partner"] },
      { href: "/motorcycles", en: "Motorcycles", fr: "Motos", icon: Bike, roles: ["manager", "cashier", "partner"] },
      { href: "/containers", en: "Containers", fr: "Conteneurs", icon: Container, roles: ["manager", "partner"] },
      { href: "/stock/import", en: "Stock import", fr: "Import de stock", icon: FileUp, roles: ["manager"] },
    ],
  },
  {
    en: "Sales & POS",
    fr: "Ventes et caisse",
    items: [
      { href: "/pos", en: "Point of sale", fr: "Caisse", icon: ShoppingCart, roles: ["manager", "cashier"] },
      { href: "/sales", en: "Sales", fr: "Ventes", icon: Receipt, roles: ["manager", "cashier", "partner"] },
      { href: "/sales-tools", en: "Sales tools", fr: "Outils de vente", icon: LayoutGrid, roles: ["manager", "cashier", "partner"] },
    ],
  },
  {
    en: "Accounting",
    fr: "Comptabilité",
    items: [
      { href: "/accounts", en: "Accounts", fr: "Comptes", icon: Landmark, roles: ["manager", "partner"] },
      { href: "/money", en: "Cash and accounts", fr: "Caisse et comptes", icon: HandCoins, roles: ["manager", "partner"] },
      { href: "/expenses", en: "Expenses", fr: "Dépenses", icon: Wallet, roles: ["manager", "partner"] },
      { href: "/contacts", en: "Customers and suppliers", fr: "Clients et fournisseurs", icon: Users, roles: ["manager", "cashier", "partner"] },
      { href: "/payroll", en: "Payroll", fr: "Paie", icon: UserCheck, roles: ["manager", "partner"] },
      { href: "/partners", en: "Partners and months", fr: "Associés et mois", icon: PieChart, roles: ["manager", "partner"] },
    ],
  },
  {
    en: "Analytics",
    fr: "Analyses",
    items: [
      { href: "/analytics", en: "Analytics", fr: "Analyses", icon: TrendingUp, roles: ["manager", "partner"] },
      { href: "/reports", en: "Reports", fr: "Rapports", icon: BarChart3, roles: ["manager", "partner"] },
    ],
  },
  {
    en: "Admin",
    fr: "Admin",
    items: [{ href: "/settings", en: "Settings", fr: "Paramètres", icon: SettingsIcon, roles: [] }],
  },
];

function NavLinks() {
  const { can } = useAuth();
  const { lang } = useI18n();
  const [location] = useLocation();
  const { setOpenMobile } = useSidebar();
  return (
    <>
      {NAV.map((group) => {
        const items = group.items.filter((i) => can(...i.roles));
        if (!items.length) return null;
        return (
          <SidebarGroup key={group.en}>
            <SidebarGroupLabel>{lang === "fr" ? group.fr : group.en}</SidebarGroupLabel>
            <SidebarGroupContent>
              <SidebarMenu>
                {items.map((item) => {
                  const active = item.href === "/" || item.exact ? location === item.href : location === item.href || location.startsWith(item.href + "/");
                  return (
                    <SidebarMenuItem key={item.href}>
                      <SidebarMenuButton asChild isActive={active}>
                        <Link href={item.href} onClick={() => setOpenMobile(false)}>
                          <item.icon className="h-4 w-4" />
                          <span>{lang === "fr" ? item.fr : item.en}</span>
                        </Link>
                      </SidebarMenuButton>
                    </SidebarMenuItem>
                  );
                })}
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
        );
      })}
    </>
  );
}

export function AppLayout({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  const { lang, setLang, t } = useI18n();

  async function logout() {
    await api("POST", "/api/auth/logout");
    queryClient.clear();
    window.location.href = "/";
  }

  return (
    <SidebarProvider>
      <Sidebar>
        <SidebarHeader>
          <div className="px-2 py-3">
            <p className="text-lg font-bold text-sidebar-primary">HUANGHE</p>
            <p className="text-xs text-sidebar-foreground/70">Kalemie</p>
          </div>
        </SidebarHeader>
        <SidebarContent>
          <NavLinks />
        </SidebarContent>
        <SidebarFooter>
          <div className="px-2 pb-2 text-xs text-sidebar-foreground/70">
            {user?.fullName} · {user?.role}
          </div>
        </SidebarFooter>
      </Sidebar>
      <SidebarInset>
        <header className="sticky top-0 z-20 flex h-14 items-center gap-2 border-b bg-background/95 px-3 backdrop-blur">
          <SidebarTrigger />
          <div className="flex-1" />
          <Button variant="ghost" size="sm" onClick={() => setLang(lang === "fr" ? "en" : "fr")} aria-label="Language">
            {lang === "fr" ? "EN" : "FR"}
          </Button>
          <ThemeToggle />
          <Button variant="ghost" size="sm" onClick={logout}>
            <LogOut className="mr-1 h-4 w-4" /> {t("Sign out", "Déconnexion")}
          </Button>
        </header>
        <main className="mx-auto w-full max-w-7xl flex-1 p-4 md:p-6">{children}</main>
      </SidebarInset>
    </SidebarProvider>
  );
}
