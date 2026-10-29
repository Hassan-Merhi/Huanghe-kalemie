import { useEffect, useRef, useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { roleLabel } from "@/lib/labels";
import { Link, useLocation } from "wouter";
import {
  BarChart3,
  Boxes,
  Container,
  LayoutDashboard,
  LogOut,
  Package,
  Receipt,
  Settings as SettingsIcon,
  ShoppingCart,
  Users,
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
  /** What a cashier sees instead (they work with customers only). */
  cashier?: { en: string; fr: string };
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
      { href: "/contacts", en: "Customers and suppliers", fr: "Clients et fournisseurs", cashier: { en: "Customers", fr: "Clients" }, icon: Users, roles: ["manager", "cashier", "partner"] },
    ],
  },
  {
    en: "Goods",
    fr: "Marchandises",
    items: [
      { href: "/inventory", en: "Inventory", fr: "Inventaire", icon: Boxes, roles: ["manager", "partner"] },
      { href: "/products", en: "Items", fr: "Articles", icon: Package, roles: ["manager", "cashier", "partner"] },
      { href: "/motorcycles", en: "Motorcycles", fr: "Motos", icon: Bike, roles: ["manager", "cashier", "partner"] },
      { href: "/containers", en: "Containers", fr: "Conteneurs", icon: Container, roles: ["manager", "partner"] },
    ],
  },
  {
    en: "Accounting",
    fr: "Comptabilité",
    items: [
      { href: "/daybook", en: "Daybook", fr: "Journal du jour", icon: BookOpen, roles: ["manager", "partner"] },
      { href: "/vouchers", en: "Vouchers", fr: "Pièces", icon: FileText, roles: ["manager", "partner"], also: ["/optional-vouchers"] },
      { href: "/accounts", en: "Accounts", fr: "Comptes", icon: Landmark, roles: ["manager", "partner"] },
      { href: "/payroll", en: "Payroll", fr: "Paie", icon: UserCheck, roles: ["manager", "partner"] },
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
  // Settings (owner only) sit in the menu's footer, so the owner's whole menu fits a 1024×768 screen.
];

const under = (location: string, href: string) => location === href || location.startsWith(href + "/");

/** Pages that share one menu entry, shown as tabs above the page. */
const SECTIONS: { href: string; en: string; fr: string; roles: Role[] }[][] = [
  [
    { href: "/stock", en: "Stock", fr: "Stock", roles: ["manager", "partner"] },
  ],
  [
    { href: "/vouchers", en: "Vouchers", fr: "Pièces", roles: ["manager", "partner"] },
    { href: "/optional-vouchers", en: "Pending vouchers", fr: "Pièces en attente", roles: ["manager", "partner"] },
  ],
];

/** Stock uses valuation as its only view; old inventory links can still return to it. */
const INLINE_SECTION = "/stock";

/** Links to the other pages of the stock section, for the end of a page's own tab bar. */
export function SectionLinks() {
  const { can } = useAuth();
  const { lang } = useI18n();
  const [location] = useLocation();
  const section = SECTIONS.find((tabs) => tabs[0].href === INLINE_SECTION)!;
  const tabs = section.filter((tab) => can(...tab.roles) && tab.href !== location);
  if (!tabs.length) return null;
  return (
    <>
      <span className="mx-1 h-5 w-px self-center bg-border" aria-hidden />
      {tabs.map((tab) => (
        <Link
          key={tab.href}
          href={tab.href}
          className="inline-flex items-center whitespace-nowrap rounded-sm px-3 py-1.5 text-sm font-medium text-orange-800 hover:underline dark:text-orange-400"
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
  const { can, user } = useAuth();
  const { lang } = useI18n();
  const label = (item: NavItem) => (user?.role === "cashier" && item.cashier ? item.cashier : item);
  const [location] = useLocation();
  const close = useCloseMenu();
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
          // Tight spacing (one link every 32 px) so a manager's whole menu fits a 768 px tall screen.
          <SidebarGroup key={group.en} className="py-0.5">
            <SidebarGroupLabel className="h-6">{lang === "fr" ? group.fr : group.en}</SidebarGroupLabel>
            <SidebarGroupContent>
              <SidebarMenu className="gap-0">
                {items.map((item) => {
                  const active =
                    item.href === "/" || item.exact ? location === item.href : under(location, item.href) || !!item.also?.some((h) => under(location, h));
                  return (
                    <SidebarMenuItem key={item.href}>
                      <SidebarMenuButton asChild isActive={active}>
                        <Link href={item.href} onClick={close}>
                          <item.icon className="h-4 w-4" />
                          <span>{lang === "fr" ? label(item).fr : label(item).en}</span>
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

/** The owner's settings, beside their name at the foot of the menu. */
function SettingsLink() {
  const { lang } = useI18n();
  const [location] = useLocation();
  const close = useCloseMenu();
  const active = under(location, "/settings");
  return (
    <Link
      href="/settings"
      onClick={close}
      aria-current={active ? "page" : undefined}
      data-active={active || undefined}
      className={cn(
        "flex shrink-0 items-center gap-2 rounded-md px-2 py-1.5 text-sm text-sidebar-foreground outline-none ring-sidebar-ring hover:bg-sidebar-accent hover:text-sidebar-accent-foreground focus-visible:ring-2",
        active && "bg-sidebar-accent font-medium text-sidebar-accent-foreground",
      )}
    >
      <SettingsIcon className="h-4 w-4" />
      <span>{lang === "fr" ? "Paramètres" : "Settings"}</span>
    </Link>
  );
}

/** A fade at the foot of the menu while more entries are hidden below it, so a short screen shows it scrolls. */
function MoreBelow() {
  const ref = useRef<HTMLDivElement>(null);
  const [more, setMore] = useState(false);
  useEffect(() => {
    const box = ref.current?.parentElement;
    if (!box) return;
    const check = () => setMore(box.scrollHeight - box.scrollTop - box.clientHeight > 4);
    check();
    box.addEventListener("scroll", check, { passive: true });
    window.addEventListener("resize", check);
    const ro = typeof ResizeObserver !== "undefined" ? new ResizeObserver(check) : null;
    ro?.observe(box);
    return () => {
      box.removeEventListener("scroll", check);
      window.removeEventListener("resize", check);
      ro?.disconnect();
    };
  }, []);
  return (
    <div
      ref={ref}
      aria-hidden
      data-testid="menu-more-below"
      data-more={more || undefined}
      className={cn("pointer-events-none sticky bottom-0 -mt-10 h-10 shrink-0 bg-gradient-to-t from-sidebar via-sidebar/80 to-transparent transition-opacity", more ? "opacity-100" : "opacity-0")}
    />
  );
}

/**
 * Below 1280 px the menu starts closed (the button at the top opens it): beside it, a 1024 px screen
 * left the tables 720 px and hid their last columns. Crossing that width opens or closes it again.
 */
const WIDE_MENU = "(min-width: 1280px)";
const wideScreen = () => typeof window === "undefined" || !window.matchMedia || window.matchMedia(WIDE_MENU).matches;

/**
 * Picking a page closes the menu on a phone, and below 1280 px on a desktop too: opened there by hand, it would
 * stay beside the next page and push its tables' last columns off screen (as it starts closed there).
 */
function useCloseMenu() {
  const { setOpenMobile, setOpen } = useSidebar();
  return () => {
    setOpenMobile(false);
    if (!wideScreen()) setOpen(false);
  };
}

function MenuFollowsWidth() {
  const { setOpen } = useSidebar();
  useEffect(() => {
    if (!window.matchMedia) return;
    const mql = window.matchMedia(WIDE_MENU);
    const onChange = (e: MediaQueryListEvent) => setOpen(e.matches);
    mql.addEventListener("change", onChange);
    return () => mql.removeEventListener("change", onChange);
  }, [setOpen]);
  return null;
}

export function AppLayout({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  const { lang, setLang, t } = useI18n();
  const companies = useQuery<{ id: number; name: string }[]>({ queryKey: ["/api/auth/companies"], staleTime: 300_000 });
  const currentCompanyName = companies.data?.find((row) => row.id === user?.companyId)?.name ?? "Kalemie";

  async function logout() {
    await api("POST", "/api/auth/logout");
    queryClient.clear();
    window.location.href = "/";
  }

  return (
    <SidebarProvider defaultOpen={wideScreen()}>
      <MenuFollowsWidth />
      <Sidebar>
        <SidebarHeader>
          <div className="px-2 py-1">
            <p className="text-lg font-bold text-sidebar-primary">HUANGHE</p>
            <p className="truncate text-xs text-sidebar-foreground/70" title={currentCompanyName}>{currentCompanyName}</p>
          </div>
        </SidebarHeader>
        {/* The menu scrolls on its own above the footer, so a short screen never hides an entry under it. */}
        <SidebarContent className="gap-0 [scrollbar-color:hsl(var(--sidebar-border))_transparent] [scrollbar-width:thin]">
          <NavLinks />
          <MoreBelow />
        </SidebarContent>
        <SidebarFooter className="border-t border-sidebar-border">
          <div className="flex items-center gap-2">
            {/* The name, then the role on its own line: "Associé(e) (lecture seule)" is too long to cut. */}
            <div className="min-w-0 flex-1 px-2 py-1 text-xs leading-snug text-sidebar-foreground/70">
              {user && <div className="truncate">{user.fullName}</div>}
              {user && user.fullName !== roleLabel(user.role, t) && <div className="break-words">{roleLabel(user.role, t)}</div>}
            </div>
            {user?.role === "owner" && <SettingsLink />}
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
