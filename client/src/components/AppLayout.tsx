import { useEffect, type ReactNode } from "react";
import { roleLabel } from "@/lib/labels";
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
import { cn } from "@/lib/utils";
import { MyAccountButton } from "@/components/MyAccount";

interface NavItem {
  href: string;
  en: string;
  fr: string;
  icon: typeof LayoutDashboard;
  roles: Role[];
  /** Only highlight on this exact path (not its sub-pages). */
  exact?: boolean;
  /** Other pages that belong to this entry (shown as tabs on the page). */
  also?: string[];
}

const NAV: { en: string; fr: string; items: NavItem[] }[] = [
  {
    en: "Shop",
    fr: "Boutique",
    items: [
      { href: "/", en: "Dashboard", fr: "Tableau de bord", icon: LayoutDashboard, roles: ["manager", "partner"] },
      { href: "/pos", en: "Point of sale", fr: "Caisse", icon: ShoppingCart, roles: ["manager", "cashier"] },
      { href: "/sales", en: "Sales", fr: "Ventes", icon: Receipt, roles: ["manager", "cashier", "partner"] },
      { href: "/sales-tools", en: "Sales tools", fr: "Outils de vente", icon: LayoutGrid, roles: ["manager", "cashier", "partner"] },
      { href: "/contacts", en: "Customers and suppliers", fr: "Clients et fournisseurs", icon: Users, roles: ["manager", "cashier", "partner"] },
    ],
  },
  {
    en: "Stock",
    fr: "Stock",
    items: [
      { href: "/stock", en: "Stock", fr: "Stock", icon: Boxes, roles: ["manager", "partner"], also: ["/inventory"] },
      { href: "/products", en: "Items", fr: "Articles", icon: Package, roles: ["manager", "cashier", "partner"] },
      { href: "/motorcycles", en: "Motorcycles", fr: "Motos", icon: Bike, roles: ["manager", "cashier", "partner"] },
      { href: "/containers", en: "Containers", fr: "Conteneurs", icon: Container, roles: ["manager", "partner"] },
    ],
  },
  {
    en: "Money",
    fr: "Argent",
    items: [
      { href: "/money", en: "Treasury", fr: "Trésorerie", icon: HandCoins, roles: ["manager", "partner"] },
      { href: "/expenses", en: "Expenses", fr: "Dépenses", icon: Wallet, roles: ["manager", "partner"] },
      { href: "/payroll", en: "Payroll", fr: "Paie", icon: UserCheck, roles: ["manager", "partner"] },
    ],
  },
  {
    en: "Accounting",
    fr: "Comptabilité",
    items: [
      { href: "/daybook", en: "Daybook", fr: "Journal du jour", icon: BookOpen, roles: ["manager", "partner"] },
      { href: "/vouchers", en: "Vouchers", fr: "Pièces", icon: FileText, roles: ["manager", "partner"], also: ["/optional-vouchers"] },
      { href: "/accounts", en: "Accounts", fr: "Comptes", icon: Landmark, roles: ["manager", "partner"] },
      { href: "/partners", en: "Partners and months", fr: "Associés et mois", icon: PieChart, roles: ["manager", "partner"] },
    ],
  },
  {
    en: "Figures",
    fr: "Chiffres",
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

const under = (location: string, href: string) => location === href || location.startsWith(href + "/");

/** Pages that share one menu entry, shown as tabs above the page. */
const SECTIONS: { href: string; en: string; fr: string; roles: Role[] }[][] = [
  [
    { href: "/stock", en: "Stock", fr: "Stock", roles: ["manager", "partner"] },
    { href: "/inventory", en: "Stock count", fr: "Inventaire", roles: ["manager", "partner"] },
    { href: "/stock/import", en: "Import", fr: "Import", roles: ["manager"] },
  ],
  [
    { href: "/vouchers", en: "Vouchers", fr: "Pièces", roles: ["manager", "partner"] },
    { href: "/optional-vouchers", en: "Pending vouchers", fr: "Pièces en attente", roles: ["manager", "partner"] },
  ],
];

/** The stock pages each have their own tab bar; their sister pages are links at the end of it (one row, not two). */
const INLINE_SECTION = "/stock";

/** Links to the other pages of the stock section, for the end of a page's own tab bar. */
export function SectionLinks() {
  const { can } = useAuth();
  const { lang } = useI18n();
  const [location] = useLocation();
  const section = SECTIONS.find((tabs) => tabs[0].href === INLINE_SECTION)!;
  const tabs = section.filter((tab) => can(...tab.roles) && tab.href !== location);
  return (
    <>
      <span className="mx-1 h-5 w-px self-center bg-border" aria-hidden />
      {tabs.map((tab) => (
        <Link
          key={tab.href}
          href={tab.href}
          className="inline-flex items-center whitespace-nowrap rounded-sm px-3 py-1.5 text-sm font-medium text-primary hover:underline dark:text-orange-400"
        >
          {lang === "fr" ? tab.fr : tab.en} →
        </Link>
      ))}
    </>
  );
}

function SectionTabs() {
  const { can } = useAuth();
  const { lang } = useI18n();
  const [location] = useLocation();
  const section = SECTIONS.find((tabs) => tabs[0].href !== INLINE_SECTION && tabs.some((tab) => tab.href === location));
  const tabs = section?.filter((tab) => can(...tab.roles)) ?? [];
  if (tabs.length < 2) return null;
  return (
    <nav className="-mt-1 mb-5 flex max-w-full flex-wrap gap-x-5 border-b text-muted-foreground" aria-label={lang === "fr" ? "Onglets" : "Tabs"}>
      {tabs.map((tab) => {
        const active = tab.href === location;
        return (
          <Link
            key={tab.href}
            href={tab.href}
            aria-current={active ? "page" : undefined}
            className={cn(
              "-mb-px border-b-2 py-2 text-sm font-medium transition-colors",
              active ? "border-primary text-foreground" : "border-transparent hover:text-foreground",
            )}
          >
            {lang === "fr" ? tab.fr : tab.en}
          </Link>
        );
      })}
    </nav>
  );
}

function NavLinks() {
  const { can } = useAuth();
  const { lang } = useI18n();
  const [location] = useLocation();
  const { setOpenMobile } = useSidebar();
  // Keep the current page's entry in view when the menu is taller than the screen.
  useEffect(() => {
    document.querySelector<HTMLElement>('[data-sidebar="content"] [data-active="true"]')?.scrollIntoView({ block: "nearest" });
  }, [location]);
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
                  const active =
                    item.href === "/" || item.exact ? location === item.href : under(location, item.href) || !!item.also?.some((h) => under(location, h));
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
        {/* The menu scrolls on its own above the footer, so a short screen never hides an entry under it. */}
        <SidebarContent className="[scrollbar-color:hsl(var(--sidebar-border))_transparent] [scrollbar-width:thin]">
          <NavLinks />
        </SidebarContent>
        <SidebarFooter className="border-t border-sidebar-border">
          <div className="truncate px-2 py-1 text-xs text-sidebar-foreground/70">
            {user?.fullName} · {user ? roleLabel(user.role, t) : ""}
          </div>
        </SidebarFooter>
      </Sidebar>
      <SidebarInset className="min-w-0">
        <header className="sticky top-0 z-20 flex h-14 items-center gap-2 border-b bg-background/95 px-3 backdrop-blur">
          <SidebarTrigger />
          <div className="flex-1" />
          <Button variant="ghost" size="sm" onClick={() => setLang(lang === "fr" ? "en" : "fr")} aria-label={t("Language: switch to French", "Langue\u00a0: passer en anglais")}>
            {lang === "fr" ? "EN" : "FR"}
          </Button>
          <ThemeToggle />
          <MyAccountButton />
          <Button variant="ghost" size="sm" onClick={logout} aria-label={t("Sign out", "Déconnexion")}>
            <LogOut className="h-4 w-4 sm:mr-1" /> <span className="hidden sm:inline">{t("Sign out", "Déconnexion")}</span>
          </Button>
        </header>
        {/* SidebarInset is the page's <main>; this is only the content width. */}
        <div className="mx-auto w-full max-w-7xl flex-1 p-4 md:p-6">
          <SectionTabs />
          {children}
        </div>
      </SidebarInset>
    </SidebarProvider>
  );
}
