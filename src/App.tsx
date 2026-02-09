import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Button } from "@/components/ui/button";
import { Settings, Search, Download, ListOrdered } from "lucide-react";
import { SettingsDialog } from "@/components/SettingsDialog";
import { SearchTab } from "@/components/SearchTab";
import { ProjectTab } from "@/components/ProjectTab";
import { ArrangeTab } from "@/components/ArrangeTab";
import type { AppSettings, Clip, Project, ProjectClip } from "@/types";
import "./App.css";

const DEFAULT_SETTINGS: AppSettings = {
  hubspotToken: "",
  rootFolder: "",
};

function App() {
  const [settings, setSettings] = useState<AppSettings>(() => {
    const saved = localStorage.getItem("compi-settings");
    return saved ? JSON.parse(saved) : DEFAULT_SETTINGS;
  });
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [project, setProject] = useState<Project | null>(null);
  const [activeTab, setActiveTab] = useState("project");

  const saveSettings = (next: AppSettings) => {
    setSettings(next);
    localStorage.setItem("compi-settings", JSON.stringify(next));
  };

  const isConfigured = settings.hubspotToken && settings.rootFolder;

  /** Add clip to project and trigger download immediately */
  const addClipToProject = (clip: Clip) => {
    if (!project) return;
    if (project.clips.some((c) => c.hubspotId === clip.id)) return;

    const newClip: ProjectClip = {
      hubspotId: clip.id,
      link: clip.link,
      creatorName: clip.creatorName,
      tags: clip.tags,
      downloadStatus: "pending",
      order: project.clips.length,
    };
    const updated = { ...project, clips: [...project.clips, newClip] };
    setProject(updated);

    // Save and auto-download
    invoke("save_project_data", {
      rootFolder: settings.rootFolder,
      project: updated,
    }).catch(() => {});
    invoke("download_clip", {
      rootFolder: settings.rootFolder,
      projectName: project.name,
      clipId: clip.id,
      url: clip.link,
    }).catch(() => {});
  };

  /** Remove clip from project */
  const removeClipFromProject = (hubspotId: string) => {
    if (!project) return;
    const updated = {
      ...project,
      clips: project.clips
        .filter((c) => c.hubspotId !== hubspotId)
        .map((c, i) => ({ ...c, order: i })),
    };
    setProject(updated);
    invoke("save_project_data", {
      rootFolder: settings.rootFolder,
      project: updated,
    }).catch(() => {});
  };

  return (
    <div className="flex h-screen flex-col">
      {/* Header */}
      <header className="flex items-center justify-between border-b px-4 py-2">
        <h1 className="text-lg font-semibold">Compi Builder</h1>
        <div className="flex items-center gap-2">
          {project && (
            <span className="text-sm text-muted-foreground">
              Project: {project.name}
            </span>
          )}
          <Button
            variant="ghost"
            size="icon"
            onClick={() => setSettingsOpen(true)}
          >
            <Settings className="h-5 w-5" />
          </Button>
        </div>
      </header>

      {/* Main content */}
      {!isConfigured ? (
        <div className="flex flex-1 items-center justify-center">
          <div className="text-center">
            <p className="mb-4 text-muted-foreground">
              Configure your HubSpot token and project folder to get started.
            </p>
            <Button onClick={() => setSettingsOpen(true)}>
              Open Settings
            </Button>
          </div>
        </div>
      ) : (
        <Tabs
          value={activeTab}
          onValueChange={setActiveTab}
          className="flex flex-1 flex-col overflow-hidden"
        >
          <TabsList className="mx-4 mt-2 w-fit">
            <TabsTrigger value="project">
              <Download className="mr-1.5 h-4 w-4" />
              Project
            </TabsTrigger>
            <TabsTrigger value="search">
              <Search className="mr-1.5 h-4 w-4" />
              Search
            </TabsTrigger>
            <TabsTrigger value="arrange">
              <ListOrdered className="mr-1.5 h-4 w-4" />
              Arrange
            </TabsTrigger>
          </TabsList>

          {/* Keep all tabs mounted, toggle visibility with CSS */}
          <div className={`flex-1 overflow-auto px-4 ${activeTab === "project" ? "" : "hidden"}`}>
            <ProjectTab
              settings={settings}
              project={project}
              setProject={setProject}
              removeClip={removeClipFromProject}
            />
          </div>
          <div className={`flex-1 overflow-auto px-4 ${activeTab === "search" ? "" : "hidden"}`}>
            <SearchTab
              settings={settings}
              project={project}
              addClip={addClipToProject}
              removeClip={removeClipFromProject}
            />
          </div>
          <div className={`flex-1 overflow-auto px-4 ${activeTab === "arrange" ? "" : "hidden"}`}>
            <ArrangeTab
              settings={settings}
              project={project}
              setProject={setProject}
            />
          </div>
        </Tabs>
      )}

      <SettingsDialog
        open={settingsOpen}
        onOpenChange={setSettingsOpen}
        settings={settings}
        onSave={saveSettings}
      />
    </div>
  );
}

export default App;
