import { useEffect, type MouseEvent as ReactMouseEvent } from "react";
import { desktopTitleBarMenus, productName } from "../../constants";
import { useLinuxWindowChrome } from "../../hooks/useLinuxWindowChrome";
import type { LinuxWindowChromeState, WindowButton } from "../../../../src/shared/linux-desktop-appearance.js";

type DesktopTitleBarMenuId = typeof desktopTitleBarMenus[number]["id"];

function WindowButtonIcon({ button, restore }: { button: WindowButton; restore: boolean }) {
  // 16px symbolic glyphs drawn in the text color, as GNOME's title-bar buttons are.
  if (button === "minimize") return <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 11.5h8" /></svg>;
  if (button === "close") return <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4.5 4.5l7 7M11.5 4.5l-7 7" /></svg>;
  if (restore) return <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M5.5 6.5h5v5h-5z" /><path d="M7 5h4.5a.5.5 0 0 1 .5.5V10" /></svg>;
  return <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4.5 4.5h7v7h-7z" /></svg>;
}

function WindowControls({ side, buttons, chrome }: { side: "left" | "right"; buttons: WindowButton[]; chrome: LinuxWindowChromeState }) {
  const control = window.ampleFileDesktop?.window?.control;
  const restore = chrome.maximized || chrome.fullScreen;
  const label = (button: WindowButton) => button === "minimize" ? "Minimize" : button === "close" ? "Close" : restore ? "Restore" : "Maximize";
  return (
    <div className={`desktop-window-controls desktop-window-controls--${side}`} role="group" aria-label="Window">
      {buttons.map((button) => (
        <button
          key={button}
          className={`desktop-window-control desktop-window-control--${button}`}
          type="button"
          aria-label={label(button)}
          title={label(button)}
          data-window-control={button}
          onClick={() => control?.(button === "maximize" ? "toggle-maximize" : button)}
        >
          <WindowButtonIcon button={button} restore={restore} />
        </button>
      ))}
    </div>
  );
}

function DesktopTitleBar() {
  const desktop = window.ampleFileDesktop as (typeof window.ampleFileDesktop & {
    menu?: { popup: (menuId: DesktopTitleBarMenuId, point: { x: number; y: number }) => Promise<void> };
  }) | undefined;
  const appInfo = desktop?.app;
  // Linux draws its own window buttons where the desktop's layout puts them; Windows keeps Electron's overlay.
  const linuxChrome = useLinuxWindowChrome();

  useEffect(() => {
    function handleMenuAccelerator(event: KeyboardEvent) {
      if (!event.altKey || event.ctrlKey || event.metaKey || event.shiftKey || event.repeat) return;
      const key = event.key.toLowerCase();
      const menuItem = desktopTitleBarMenus.find((item) => item.label[0]?.toLowerCase() === key);
      if (!menuItem) return;
      const button = document.querySelector<HTMLButtonElement>(`[data-desktop-menu-id="${menuItem.id}"]`);
      if (!button) return;
      event.preventDefault();
      button.focus();
      openMenuFromElement(menuItem.id, button);
    }

    window.addEventListener("keydown", handleMenuAccelerator);
    return () => window.removeEventListener("keydown", handleMenuAccelerator);
  }, []);

  function openMenu(menuId: DesktopTitleBarMenuId, event: ReactMouseEvent<HTMLButtonElement>) {
    openMenuFromElement(menuId, event.currentTarget);
  }

  function openMenuFromElement(menuId: DesktopTitleBarMenuId, element: HTMLElement) {
    const rect = element.getBoundingClientRect();
    void desktop?.menu?.popup(menuId, {
      x: rect.left,
      y: rect.bottom,
    });
  }

  return (
    <header
      className={`desktop-titlebar${linuxChrome ? " desktop-titlebar--linux" : ""}`}
      aria-label="Application title bar"
      data-window-focused={linuxChrome ? String(linuxChrome.focused) : undefined}
    >
      {linuxChrome && linuxChrome.buttonLayout.left.length ? <WindowControls side="left" buttons={linuxChrome.buttonLayout.left} chrome={linuxChrome} /> : null}
      <div className="desktop-titlebar-brand">
        {appInfo?.iconUrl ? <img className="desktop-titlebar-icon" src={appInfo.iconUrl} alt="" draggable={false} /> : null}
        <span className="desktop-titlebar-name">{appInfo?.name ?? productName}</span>
      </div>
      <nav className="desktop-titlebar-menu" aria-label="Application menu">
        {desktopTitleBarMenus.map((item) => (
          <button
            key={item.id}
            className="desktop-titlebar-menu-button"
            type="button"
            aria-haspopup="menu"
            data-desktop-menu-id={item.id}
            title={`Alt+${item.label[0]}`}
            onClick={(event) => openMenu(item.id, event)}
          >
            {item.label}
          </button>
        ))}
      </nav>
      <div className="desktop-titlebar-drag-spacer" aria-hidden="true" />
      {linuxChrome && linuxChrome.buttonLayout.right.length ? <WindowControls side="right" buttons={linuxChrome.buttonLayout.right} chrome={linuxChrome} /> : null}
    </header>
  );
}

export { DesktopTitleBar };
