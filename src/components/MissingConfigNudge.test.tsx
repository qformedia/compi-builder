import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";

import {
  MissingConfigNudge,
  __clearMissingConfigNudgeDismissal,
} from "./MissingConfigNudge";

describe("<MissingConfigNudge />", () => {
  beforeEach(() => {
    __clearMissingConfigNudgeDismissal("socialkit");
    __clearMissingConfigNudgeDismissal("socialfetch");
    __clearMissingConfigNudgeDismissal("hubspot_owner_email");
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it("renders the SocialKit copy by default", () => {
    render(<MissingConfigNudge kind="socialkit" />);
    const title = screen.getByTestId("missing-config-nudge-title");
    expect(title.textContent).toMatch(/SocialKit/i);
    expect(screen.getByRole("status")).toBeTruthy();
  });

  it("renders the SocialFetch copy with the right kind", () => {
    render(<MissingConfigNudge kind="socialfetch" />);
    const title = screen.getByTestId("missing-config-nudge-title");
    expect(title.textContent).toMatch(/SocialFetch/i);
  });

  it("renders the HubSpot owner email copy with the right kind", () => {
    render(<MissingConfigNudge kind="hubspot_owner_email" />);
    const title = screen.getByTestId("missing-config-nudge-title");
    expect(title.textContent).toMatch(/HubSpot owner email/i);
  });

  it("hides itself after Dismiss is clicked", () => {
    render(<MissingConfigNudge kind="socialkit" />);
    expect(screen.queryByRole("status")).not.toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /Dismiss/i }));
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("stays dismissed across remounts within 7 days", () => {
    const { unmount } = render(<MissingConfigNudge kind="socialkit" />);
    fireEvent.click(screen.getByRole("button", { name: /Dismiss/i }));
    unmount();
    cleanup();
    render(<MissingConfigNudge kind="socialkit" />);
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("re-shows itself after the 7-day cooldown elapses", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    const { unmount } = render(<MissingConfigNudge kind="socialkit" />);
    fireEvent.click(screen.getByRole("button", { name: /Dismiss/i }));
    unmount();
    cleanup();

    // Advance the clock past 7 days.
    vi.setSystemTime(new Date("2026-01-09T00:00:01Z"));
    render(<MissingConfigNudge kind="socialkit" />);
    expect(screen.queryByRole("status")).not.toBeNull();
  });

  it("calls onOpenSettings when the CTA is clicked", () => {
    const onOpenSettings = vi.fn();
    render(
      <MissingConfigNudge
        kind="socialfetch"
        onOpenSettings={onOpenSettings}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /Open Settings/i }));
    expect(onOpenSettings).toHaveBeenCalledTimes(1);
  });

  it("renders without the CTA button when no onOpenSettings is provided", () => {
    render(<MissingConfigNudge kind="socialkit" />);
    expect(screen.queryByRole("button", { name: /Open Settings/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /Dismiss/i })).not.toBeNull();
  });

  it("dismissals are independent per kind", () => {
    const { unmount } = render(<MissingConfigNudge kind="socialkit" />);
    fireEvent.click(screen.getByRole("button", { name: /Dismiss/i }));
    unmount();
    cleanup();

    // SocialFetch should still appear because it's a separate dismissal.
    render(<MissingConfigNudge kind="socialfetch" />);
    expect(screen.queryByRole("status")).not.toBeNull();
  });
});
