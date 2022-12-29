import {
  moment,
  CachedMetadata,
  Plugin,
  TFile,
  TAbstractFile,
  getAllTags,
  Notice,
  HeadingCache,
} from "obsidian";
import { ListModifiedSettingTab } from "./settings";
import { serialize } from "monkey-around";
import {
  createDailyNote,
  getAllDailyNotes,
  getDailyNote,
} from "obsidian-daily-notes-interface";
import { ListModifiedSettings } from "./types";
import { DEFAULT_SETTINGS } from "./constants";

export default class ListModified extends Plugin {
  settings: ListModifiedSettings;
  writeIntervalInMs: number;

  async onload(): Promise<void> {
    await this.loadSettings();

    this.writeIntervalInMs = this.settings.writeInterval * 1000;

    // if interval is 0, don't run the registerInterval and instead just run on modify for performance.
    if (this.writeIntervalInMs) {
      this.registerInterval(
        window.setInterval(async () => {
          await this.updateTrackedFiles(true);
        }, this.writeIntervalInMs)
      );
    }

    this.registerEvent(
      this.app.metadataCache.on("changed", this.onCacheChange)
    );

    this.registerEvent(this.app.vault.on("delete", this.onVaultDelete));
    this.registerEvent(this.app.vault.on("rename", this.onVaultRename));

    this.addSettingTab(new ListModifiedSettingTab(this.app, this));
  }

  private onCacheChange = serialize(
    async (file: TFile, _data: string, cache: CachedMetadata) => {
      const trackedFiles = this.settings.trackedFiles;
      const currentDate = moment().format("YYYY-MM-DD");

      if (this.settings.lastTrackedDate !== currentDate) {
        // last effort to write to file
        await this.updateTrackedFiles();
        this.settings.trackedFiles = [];
        this.settings.lastTrackedDate = currentDate;
      }

      const path: string = file.path;

      if (file === getDailyNote(moment(), getAllDailyNotes())) {
        return;
      }

      // make shift set
      if (
        !trackedFiles.includes(path) &&
        !this.cacheContainsIgnoredTag(cache) &&
        !this.pathIsExcluded(path) &&
        !this.noteTitleContainsIgnoredText(file.basename)
      ) {
        trackedFiles.push(path);
      }

      if (
        (trackedFiles.includes(path) && this.cacheContainsIgnoredTag(cache)) ||
        this.pathIsExcluded(path) ||
        this.noteTitleContainsIgnoredText(file.basename)
      ) {
        trackedFiles.remove(path);
      }

      await this.updateTrackedFiles();
    }
  );

  private noteTitleContainsIgnoredText(noteTitle: string): boolean {
    const ignoredText = this.settings.ignoredNameContains
      .replace(/\s/g, "")
      .split(",");

    return ignoredText.some((ignoredText: string) => {
      const title = noteTitle.toLowerCase();
      const text = ignoredText.toLowerCase();
      if (!text) {
        return false;
      }
      return title.includes(text);
    });
  }

  private cacheContainsIgnoredTag(cache: CachedMetadata): boolean {
    const currentFileTags: string[] = getAllTags(cache);
    const ignoredTags = this.settings.tags.replace(/\s/g, "").split(",");
    return ignoredTags.some((ignoredTag: string) =>
      currentFileTags.includes(ignoredTag)
    );
  }

  private pathIsExcluded(path: string): boolean {
    const excludedFolders = this.settings.excludedFolders;
    if (!excludedFolders) return false;
    const excludedFolderPaths: string[] = excludedFolders
      .replace(/\s*, | \s*,/, ",")
      .split(",")
      .map((item) => item.replace(/^\/|\/$/g, ""));

    const currentFilePath: string =
      this.app.vault.getAbstractFileByPath(path).parent.path;

    return excludedFolderPaths.some((excludedFolder: string) =>
      currentFilePath.startsWith(excludedFolder)
    );
  }

  private onVaultDelete = serialize(async (file: TAbstractFile) => {
    if (file instanceof TFile) {
      if (this.settings.trackedFiles.includes(file.path)) {
        this.settings.trackedFiles.remove(file.path);
        await this.updateTrackedFiles();
      }
    }
  });

  private onVaultRename = serialize(
    async (file: TAbstractFile, oldPath: string) => {
      if (file instanceof TFile) {
        if (this.settings.trackedFiles.includes(oldPath)) {
          this.settings.trackedFiles.remove(oldPath);
          this.settings.trackedFiles.push(file.path);

          await this.saveSettings();
          // obsidian already handles link renames
          if (!this.settings.outputFormat.includes("[[link]]")) {
            await this.updateTrackedFiles();
          }
        }
      }
    }
  );

  updateTrackedFiles = serialize(async (doWrite?: boolean) => {
    await this.saveSettings();

    let dailyNote: TFile;

    try {
      dailyNote = getDailyNote(moment(), getAllDailyNotes());
    } catch (e) {
      new Notice("Unable to load daily note. See console for details.");
      console.error(e.message);
    }

    if (!dailyNote) {
      if (this.settings.automaticallyCreateDailyNote) {
        this.displayNotice("Creating daily note since it did not exist...");
        dailyNote = await createDailyNote(moment());
      }

      this.updateTrackedFiles();
    }

    let cache: CachedMetadata = this.app.metadataCache.getFileCache(dailyNote);

    let currentHeadings: HeadingCache[] = cache?.headings;

    let content: string[] = (await this.app.vault.read(dailyNote)).split("\n");

    // auto-create heading
    if (!currentHeadings || !this.settings.heading) {
      this.displayNotice(
        "Cannot find the designated heading in your file. Creating a default one for now..."
      );

      // mock heading for first run to avoid error
      currentHeadings = [
        { heading: this.settings.heading, level: 1 } as HeadingCache,
      ];

      await this.app.vault.append(
        dailyNote,
        "\n" +
          "# " +
          this.settings.heading +
          "\n" +
          this.settings.trackedFiles
            .map((path) => this.getFormattedOutput(path))
            .join("\n")
      );

      await this.saveSettings();
      return;
    }

    // if user set delay, do not write to file after initial run
    if (this.writeIntervalInMs && !doWrite) {
      return;
    }

    for (let i = 0; i < currentHeadings.length; i++) {
      if (currentHeadings[i].heading === this.settings.heading) {
        const startPos: number = currentHeadings[i].position.end.line + 1;
        if (currentHeadings[i + 1]) {
          const endPos: number = currentHeadings[i + 1].position.start.line - 1;
          content.splice(
            startPos,
            endPos - startPos,
            ...this.settings.trackedFiles.map((path) =>
              this.getFormattedOutput(path)
            )
          );
        } else {
          const endPos: number = content.length;
          content.splice(
            startPos,
            endPos - startPos,
            ...this.settings.trackedFiles.map((path) =>
              this.getFormattedOutput(path)
            )
          );
        }

        this.app.vault.modify(dailyNote, content.join("\n"));
      }
    }
  });

  private getFormattedOutput(path: string): string {
    const file: TFile = this.app.vault.getAbstractFileByPath(path) as TFile;

    return this.settings.outputFormat
      .replace(
        "[[link]]",
        this.app.fileManager.generateMarkdownLink(
          file,
          getDailyNote(moment(), getAllDailyNotes()).path
        )
      )
      .replace("[[name]]", file.basename)
      .replace(
        "[[tags]]",
        getAllTags(this.app.metadataCache.getFileCache(file))
          .map((tag) => "\\" + tag)
          .join(", ")
      )
      .replace("[[ctime]]", moment(file.stat.ctime).format("YYYY-MM-DD"));
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }

  private async loadSettings(): Promise<void> {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  public displayNotice(message: string) {
    new Notice("[Obsidian List Modified] " + message);
  }
}
