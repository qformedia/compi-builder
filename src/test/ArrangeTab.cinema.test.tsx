/**
 * Tests for the cinema mode (fullscreen overlay) in ArrangeTab.
 *
 * Bug: Clicking cinema mode caused double audio because playerContent was
 * rendered in both the left column and the overlay simultaneously — two
 * independent <video> elements, both playing audio at the same time.
 *
 * Fix: The left column renders the player only when cinemaMode === false.
 * The overlay renders the player only when cinemaMode === true.
 * At most one <MediaPlayer> instance exists at any given time.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";

// ---------------------------------------------------------------------------
// Module mocks — must be declared before any component imports so that
// Vitest's hoisting runs these factories before the real modules load.
// ---------------------------------------------------------------------------

// @vidstack/react reads localStorage at module init time; mock it entirely.
vi.mock("@vidstack/react", () => ({
  MediaPlayer: ({ children, ...props }: any) => (
    <div
      data-testid="media-player"
      data-src={props.src ?? ""}
      data-autoplay={String(props.autoPlay ?? false)}
    >
      {children}
    </div>
  ),
  MediaProvider: () => <div data-testid="media-provider" />,
  useMediaPlayer: () => null,
  MediaPlayerInstance: class {},
}));
vi.mock("@vidstack/react/icons", () => ({
  default: {},
  defaultLayoutIcons: {},
}));
vi.mock("@vidstack/react/player/layouts/default", () => ({
  DefaultVideoLayout: () => null,
  defaultLayoutIcons: {},
}));
vi.mock("@vidstack/react/player/styles/default/theme.css", () => ({}));
vi.mock("@vidstack/react/player/styles/default/layouts/video.css", () => ({}));

// DnD-kit — not relevant to playback tests; pass-through stubs.
vi.mock("@dnd-kit/core", async (importOriginal) => {
  const actual = await importOriginal<any>();
  return {
    ...actual,
    DndContext: ({ children }: any) => <div>{children}</div>,
    useSensor: vi.fn(),
    useSensors: vi.fn(() => []),
  };
});
vi.mock("@dnd-kit/sortable", async (importOriginal) => {
  const actual = await importOriginal<any>();
  return {
    ...actual,
    SortableContext: ({ children }: any) => <div>{children}</div>,
    useSortable: () => ({
      attributes: {},
      listeners: {},
      setNodeRef: vi.fn(),
      transform: null,
      transition: null,
      isDragging: false,
    }),
    arrayMove: vi.fn((arr: any[]) => arr),
  };
});

// Tauri APIs
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(() => Promise.resolve()),
  convertFileSrc: vi.fn((p: string) => `localfile://localhost/${p}`),
}));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn() }));
vi.mock("@tauri-apps/plugin-opener", () => ({
  openUrl: vi.fn(),
  revealItemInDir: vi.fn(),
}));

// Supabase
vi.mock("@/lib/supabase", () => ({
  isSupabaseConfigured: true,
  reportDownloadIssue: vi.fn(() => Promise.resolve()),
  submitFeedback: vi.fn(() => Promise.resolve()),
  uploadFeedbackScreenshot: vi.fn(() => Promise.resolve("")),
}));

// ---------------------------------------------------------------------------
// Imports after mocks
// ---------------------------------------------------------------------------

import { ArrangeTab } from "@/components/ArrangeTab";
import { DEFAULT_DOWNLOAD_PROVIDERS } from "@/types";
import type { AppSettings, Project } from "@/types";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const settings: AppSettings = {
  hubspotToken: "tok",
  rootFolder: "/projects",
  cookiesBrowser: "chrome",
  cookiesFile: "",
  preferHubSpotPreview: true,
  evil0ctalApiUrl: "",
  downloadProviders: DEFAULT_DOWNLOAD_PROVIDERS,
};

const projectWithDownloadedClip: Project = {
  name: "Test Project",
  createdAt: "1234567890",
  clips: [
    {
      hubspotId: "clip1",
      link: "https://instagram.com/p/abc/",
      creatorName: "Creator A",
      tags: [],
      score: "A",
      downloadStatus: "complete",
      order: 0,
      localFile: "clips/clip1_video.mp4",
      localDuration: 10,
    },
  ],
};

const noop = () => {};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("ArrangeTab — cinema mode: single MediaPlayer instance invariant", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders exactly one MediaPlayer in normal mode with autoPlay enabled", () => {
    render(
      <ArrangeTab
        settings={settings}
        project={projectWithDownloadedClip}
        setProject={noop}
        isActive={true}
        removeClip={noop}
      />,
    );

    expect(screen.queryAllByTestId("media-player")).toHaveLength(1);
    expect(screen.getByTestId("media-player").getAttribute("data-autoplay")).toBe("true");
  });

  it("renders exactly one MediaPlayer when cinema mode is open", async () => {
    render(
      <ArrangeTab
        settings={settings}
        project={projectWithDownloadedClip}
        setProject={noop}
        isActive={true}
        removeClip={noop}
      />,
    );

    const cinemaBtn = screen.getByTitle("Cinema mode (16:9)");
    await act(async () => { fireEvent.click(cinemaBtn); });

    // The critical assertion: never two players at once
    expect(screen.queryAllByTestId("media-player")).toHaveLength(1);
  });

  it("hides the inline player while the cinema overlay is open", async () => {
    render(
      <ArrangeTab
        settings={settings}
        project={projectWithDownloadedClip}
        setProject={noop}
        isActive={true}
        removeClip={noop}
      />,
    );

    // Before: one player, no overlay (the toggle button says "Cinema mode")
    expect(screen.queryAllByTestId("media-player")).toHaveLength(1);
    expect(screen.getByTitle("Cinema mode (16:9)")).toBeTruthy();

    // Open cinema mode
    await act(async () => {
      fireEvent.click(screen.getByTitle("Cinema mode (16:9)"));
    });

    // After: two "Exit cinema mode" buttons exist — the toggle in the left
    // column (which flips its title) and the X button inside the overlay.
    // Still only ONE player, confirming the fix.
    expect(screen.getAllByTitle("Exit cinema mode")).toHaveLength(2);
    expect(screen.queryAllByTestId("media-player")).toHaveLength(1);
  });

  it("restores the inline player after closing cinema mode", async () => {
    render(
      <ArrangeTab
        settings={settings}
        project={projectWithDownloadedClip}
        setProject={noop}
        isActive={true}
        removeClip={noop}
      />,
    );

    // Open cinema mode
    await act(async () => {
      fireEvent.click(screen.getByTitle("Cinema mode (16:9)"));
    });

    // Close via the overlay's own X button (the second "Exit cinema mode" button)
    const exitButtons = screen.getAllByTitle("Exit cinema mode");
    await act(async () => {
      fireEvent.click(exitButtons[exitButtons.length - 1]);
    });

    // Back to one player, toggle button says "Cinema mode" again
    expect(screen.queryAllByTestId("media-player")).toHaveLength(1);
    expect(screen.queryAllByTitle("Exit cinema mode")).toHaveLength(0);
    expect(screen.getByTitle("Cinema mode (16:9)")).toBeTruthy();
  });

  it("does not autoplay when suppressAutoPlay is true (Finish Video rename scenario)", () => {
    const { rerender } = render(
      <ArrangeTab
        settings={settings}
        project={projectWithDownloadedClip}
        setProject={noop}
        isActive={true}
        removeClip={noop}
        suppressAutoPlay={false}
      />,
    );

    // Simulate what Finish Video does: renames localFile, causing key change
    // while suppressAutoPlay is true (finish dialog is open)
    const renamedProject: Project = {
      ...projectWithDownloadedClip,
      clips: [{
        ...projectWithDownloadedClip.clips[0],
        localFile: "clips/1 - clip1_video.mp4",  // renamed by order_and_zip_clips
      }],
    };

    rerender(
      <ArrangeTab
        settings={settings}
        project={renamedProject}
        setProject={noop}
        isActive={true}
        removeClip={noop}
        suppressAutoPlay={true}
      />,
    );

    // Player remounted due to key change, but autoPlay must be false
    const player = screen.getByTestId("media-player");
    expect(player.getAttribute("data-src")).toContain("1 - clip1_video.mp4");
    expect(player.getAttribute("data-autoplay")).toBe("false");
  });

  it("renders no MediaPlayer when the clip is not yet downloaded", () => {
    const projectPending: Project = {
      ...projectWithDownloadedClip,
      clips: [{
        ...projectWithDownloadedClip.clips[0],
        downloadStatus: "pending",
        localFile: undefined,
      }],
    };

    render(
      <ArrangeTab
        settings={settings}
        project={projectPending}
        setProject={noop}
        isActive={true}
        removeClip={noop}
      />,
    );

    expect(screen.queryAllByTestId("media-player")).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Action bar tests
// ---------------------------------------------------------------------------

describe("ArrangeTab — clip action bar", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("shows Re-download and Browse for a completed clip", () => {
    render(
      <ArrangeTab
        settings={settings}
        project={projectWithDownloadedClip}
        setProject={noop}
        isActive={true}
        removeClip={noop}
      />,
    );

    expect(screen.getByTitle("Re-download")).toBeTruthy();
    expect(screen.getByTitle("Replace video with local file")).toBeTruthy();
  });

  it("shows Download and Browse for a pending clip", () => {
    const pendingProject: Project = {
      ...projectWithDownloadedClip,
      clips: [{
        ...projectWithDownloadedClip.clips[0],
        downloadStatus: "pending",
        localFile: undefined,
      }],
    };

    render(
      <ArrangeTab
        settings={settings}
        project={pendingProject}
        setProject={noop}
        isActive={true}
        removeClip={noop}
      />,
    );

    expect(screen.getByTitle("Download")).toBeTruthy();
    expect(screen.getByTitle("Replace video with local file")).toBeTruthy();
  });

  it("shows Retry and Browse for a failed clip", () => {
    const failedProject: Project = {
      ...projectWithDownloadedClip,
      clips: [{
        ...projectWithDownloadedClip.clips[0],
        downloadStatus: "failed",
        downloadError: "Some error",
        localFile: undefined,
      }],
    };

    render(
      <ArrangeTab
        settings={settings}
        project={failedProject}
        setProject={noop}
        isActive={true}
        removeClip={noop}
      />,
    );

    expect(screen.getByTitle("Retry download")).toBeTruthy();
    expect(screen.getByTitle("Replace video with local file")).toBeTruthy();
  });

  it("shows Report button for a failed clip after retry", () => {
    const failedRetried: Project = {
      ...projectWithDownloadedClip,
      clips: [{
        ...projectWithDownloadedClip.clips[0],
        downloadStatus: "failed",
        downloadError: "Some error",
        localFile: undefined,
        retryCount: 1,
      }],
    };

    render(
      <ArrangeTab
        settings={settings}
        project={failedRetried}
        setProject={noop}
        isActive={true}
        removeClip={noop}
      />,
    );

    expect(screen.getByTitle("Retry download")).toBeTruthy();
    expect(screen.getByTitle("Report issue")).toBeTruthy();
  });

  it("hides Report button when retryCount is 0", () => {
    render(
      <ArrangeTab
        settings={settings}
        project={projectWithDownloadedClip}
        setProject={noop}
        isActive={true}
        removeClip={noop}
      />,
    );

    expect(screen.queryByTitle("Report issue")).toBeNull();
  });

  it("shows Report button when retryCount >= 1", () => {
    const retriedProject: Project = {
      ...projectWithDownloadedClip,
      clips: [{
        ...projectWithDownloadedClip.clips[0],
        retryCount: 1,
      }],
    };

    render(
      <ArrangeTab
        settings={settings}
        project={retriedProject}
        setProject={noop}
        isActive={true}
        removeClip={noop}
      />,
    );

    expect(screen.getByTitle("Report issue")).toBeTruthy();
  });
});
