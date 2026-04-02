import { Film, Briefcase, Settings, PanelLeftClose, PanelLeft } from "lucide-react";
import { cn } from "@/lib/utils";

export type Page = "videos" | "clips" | "settings";

interface NavItem {
  id: Page;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
}

const NAV_ITEMS: NavItem[] = [
  { id: "videos", label: "Videos", icon: Briefcase },
  { id: "clips", label: "Clips", icon: Film },
];

interface Props {
  activePage: Page;
  onPageChange: (page: Page) => void;
  collapsed: boolean;
  onToggleCollapse: () => void;
}

export function Sidebar({ activePage, onPageChange, collapsed, onToggleCollapse }: Props) {
  return (
    <aside
      className={cn(
        "flex flex-col border-r bg-muted/30 transition-[width] duration-200",
        collapsed ? "w-11" : "w-37",
      )}
    >
      <button
        onClick={onToggleCollapse}
        className="flex h-10 items-center justify-end pr-3 text-muted-foreground hover:text-foreground cursor-pointer"
        title={collapsed ? "Expand sidebar" : "Collapse sidebar"}
      >
        {collapsed ? (
          <PanelLeft className="h-4 w-4" />
        ) : (
          <PanelLeftClose className="h-4 w-4" />
        )}
      </button>

      <nav className="flex flex-1 flex-col gap-1 px-2">
        {NAV_ITEMS.map((item) => (
          <SidebarButton
            key={item.id}
            item={item}
            active={activePage === item.id}
            collapsed={collapsed}
            onClick={() => onPageChange(item.id)}
          />
        ))}

        <div className="flex-1" />

        <div className="border-t border-border -mx-2 mb-1" />
        <SidebarButton
          item={{ id: "settings", label: "Settings", icon: Settings }}
          active={activePage === "settings"}
          collapsed={collapsed}
          onClick={() => onPageChange("settings")}
        />
        <div className="h-2" />
      </nav>
    </aside>
  );
}

function SidebarButton({
  item,
  active,
  collapsed,
  onClick,
}: {
  item: NavItem;
  active: boolean;
  collapsed: boolean;
  onClick: () => void;
}) {
  const Icon = item.icon;
  return (
    <button
      onClick={onClick}
      title={collapsed ? item.label : undefined}
      className={cn(
        "flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-colors cursor-pointer",
        active
          ? "bg-primary/10 text-primary"
          : "text-muted-foreground hover:bg-muted hover:text-foreground",
        collapsed && "justify-center px-0",
      )}
    >
      <Icon className="h-4 w-4 flex-shrink-0" />
      {!collapsed && <span>{item.label}</span>}
    </button>
  );
}
