
import { ChatAdd20Filled, ChatAdd20Regular, Globe20Filled, Globe20Regular, GlobeAdd20Filled, GlobeAdd20Regular, bundleIcon, type FluentIcon } from "@fluentui/react-icons";
import { AlertTriangle, X } from "./icons";
import type { ConnectedFolderIconOption } from "../../connected-folder-icons";

const NewChatIcon = bundleIcon(ChatAdd20Filled, ChatAdd20Regular);
const BrowserTabIcon = bundleIcon(Globe20Filled, Globe20Regular);
const NewBrowserTabIcon = bundleIcon(GlobeAdd20Filled, GlobeAdd20Regular);

function FluentGlyph({
  icon: Icon,
  size,
  filled = true,
  className,
}: {
  icon: FluentIcon;
  size: number;
  filled?: boolean;
  className?: string;
}) {
  return (
    <Icon
      className={["fluent-ui-icon", className ?? ""].filter(Boolean).join(" ")}
      style={{ fontSize: `${size}px` }}
      filled={filled}
      aria-hidden="true"
    />
  );
}

function ConnectedFolderIconGlyph({
  icon,
  size,
  filled = true,
  className,
}: {
  icon: ConnectedFolderIconOption["Icon"];
  size: number;
  filled?: boolean;
  className?: string;
}) {
  return (
    <FluentGlyph
      icon={icon}
      size={size}
      filled={filled}
      className={["connected-folder-fluent-icon", className ?? ""].filter(Boolean).join(" ")}
    />
  );
}

function Banner({ tone, text, onDismiss }: { tone: "error" | "info"; text: string; onDismiss?: () => void }) {
  return (
    <div className={`banner ${tone}`}>
      <AlertTriangle size={16} />
      <span>{text}</span>
      {onDismiss ? (
        <button className="banner-dismiss" type="button" aria-label="Dismiss" onClick={onDismiss}>
          <X size={14} />
        </button>
      ) : null}
    </div>
  );
}

export { Banner, FluentGlyph, ConnectedFolderIconGlyph };
