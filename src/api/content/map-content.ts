import axios from "axios";
import * as fs from "fs";
import { delay, removeFromArray, Signal } from "jaz-ts-utils";
import { Selectable } from "kysely";
import * as path from "path";
import { reactive } from "vue";

import { AbstractContentAPI } from "@/api/content/abstract-content-api";
import { contentSources } from "@/config/content-sources";
import type { DownloadInfo, SpringFilesMapMeta } from "@/model/downloads";
import type { MapData } from "@/model/map-data";
import { parseMap as parseMapWorkerFunction } from "@/workers/parse-map";
import { hookWorkerFunction } from "@/workers/worker-helpers";

export class MapContentAPI extends AbstractContentAPI {
    public readonly installedMaps: Selectable<MapData>[] = reactive([]);
    public readonly onMapCached: Signal<Selectable<MapData>> = new Signal();

    protected readonly mapsDir = path.join(api.info.contentPath, "maps");
    protected readonly mapImagesDir = path.join(api.info.contentPath, "map-images");
    protected readonly path7za = path.join(api.info.resourcesPath, process.platform === "win32" ? "7za.exe" : "7za");
    protected readonly parseMap = hookWorkerFunction(new Worker(new URL(`../../workers/parse-map.ts`, import.meta.url), { type: "module" }), parseMapWorkerFunction);
    protected readonly mapCacheQueue: Set<string> = reactive(new Set());
    protected cachingMaps = false;

    public override async init() {
        await fs.promises.mkdir(this.mapsDir, { recursive: true });

        await api.cacheDb.schema
            .createTable("map")
            .ifNotExists()
            .addColumn("mapId", "integer", (col) => col.primaryKey().autoIncrement())
            .addColumn("scriptName", "varchar", (col) => col.notNull().unique())
            .addColumn("fileName", "varchar", (col) => col.notNull().unique())
            .addColumn("friendlyName", "varchar", (col) => col.notNull())
            .addColumn("description", "varchar", (col) => col)
            .addColumn("mapHardness", "double precision", (col) => col.notNull())
            .addColumn("gravity", "double precision", (col) => col.notNull())
            .addColumn("tidalStrength", "double precision", (col) => col.notNull())
            .addColumn("maxMetal", "double precision", (col) => col.notNull())
            .addColumn("extractorRadius", "double precision", (col) => col.notNull())
            .addColumn("minWind", "double precision", (col) => col.notNull())
            .addColumn("maxWind", "double precision", (col) => col.notNull())
            .addColumn("startPositions", "json", (col) => col)
            .addColumn("width", "double precision", (col) => col.notNull())
            .addColumn("height", "double precision", (col) => col.notNull())
            .addColumn("minDepth", "double precision", (col) => col.notNull())
            .addColumn("maxDepth", "double precision", (col) => col.notNull())
            .addColumn("mapInfo", "json", (col) => col)
            .execute();

        await api.cacheDb.schema
            .createTable("mapError")
            .ifNotExists()
            .addColumn("fileName", "varchar", (col) => col.primaryKey())
            .execute();

        const maps = await api.cacheDb.selectFrom("map").selectAll().execute();
        this.installedMaps.push(...maps);

        await this.queueMapsToCache();

        this.cacheMaps();

        return super.init();
    }

    public async installMaps(scriptNames: string[], host = contentSources.maps.http[0]) {
        for (const scriptName of scriptNames) {
            await this.installMap(scriptName, host);
        }
    }

    // currently reliant on springfiles for scriptname lookup
    public async installMap(scriptName: string, host = contentSources.maps.http[0]!) {
        if (this.installedMaps.some((map) => map.scriptName === scriptName) || this.currentDownloads.some((download) => download.name === scriptName)) {
            return;
        }

        const searchUrl = `https://springfiles.springrts.com/json.php?springname=${scriptName}&category=map`;
        const searchResponse = await axios({
            url: searchUrl,
            method: "get",
            responseType: "json",
        });

        if (searchResponse.status !== 200) {
            throw new Error(searchResponse.statusText);
        }

        const mapResult: SpringFilesMapMeta | undefined = searchResponse.data[0];
        if (!mapResult) {
            throw new Error(`${scriptName} not found on springfiles.springrts.com`);
        }

        return this.installMapByFilename(mapResult.filename, mapResult.name, host);
    }

    public async installMapByFilename(filename: string, scriptName: string, host = contentSources.maps.http[0]!): Promise<void> {
        // TODO: tidy up this logic to avoid downloading/caching the same maps multiple times, or incorrectly assuming maps are downloaded/cached when they're not
        if (this.installedMaps.some((map) => map.fileName === filename) || this.currentDownloads.some((download) => download.name === scriptName)) {
            return;
        }

        try {
            console.debug(`Downloading map: ${filename}`);
            console.time(`Map downloaded: ${filename}`);

            const downloadInfo: DownloadInfo = reactive({
                type: "map",
                name: scriptName,
                currentBytes: 0,
                totalBytes: 1,
            });

            this.currentDownloads.push(downloadInfo);

            this.onDownloadStart.dispatch(downloadInfo);

            const downloadResponse = await axios({
                url: `${host}${filename}`,
                method: "get",
                responseType: "arraybuffer",
                headers: { "Content-Type": "application/7z" },
                adapter: require("axios/lib/adapters/http"),
                onDownloadProgress: (progress) => {
                    downloadInfo.currentBytes = progress.loaded;
                    downloadInfo.totalBytes = progress.total;
                },
            });

            if (downloadResponse.status !== 200) {
                throw new Error(downloadResponse.statusText);
            }

            const dest = path.join(this.mapsDir, filename);
            await fs.promises.writeFile(dest, Buffer.from(downloadResponse.data), { encoding: "binary" });

            console.timeEnd(`Map downloaded: ${filename}`);

            removeFromArray(this.currentDownloads, downloadInfo);
            this.onDownloadComplete.dispatch(downloadInfo);

            this.mapCacheQueue.add(filename);
        } catch (err) {
            console.error(`Failed to install map ${filename} from ${host}${filename}:`, err);
        }
    }

    public getMapImages(options: { map: Selectable<MapData> } | { fileName: string }) {
        let fileName = "";

        if ("map" in options) {
            fileName = options.map.fileName;
        } else {
            fileName = options.fileName;
        }

        const fileNameWithoutExt = path.parse(fileName).name;

        return {
            textureImagePath: path.join(this.mapImagesDir, `${fileNameWithoutExt}-texture.jpg`),
            heightImagePath: path.join(this.mapImagesDir, `${fileNameWithoutExt}-height.jpg`),
            metalImagePath: path.join(this.mapImagesDir, `${fileNameWithoutExt}-metal.jpg`),
            typeImagePath: path.join(this.mapImagesDir, `${fileNameWithoutExt}-type.jpg`),
        };
    }

    public async queueMapsToCache() {
        const mapFiles = await fs.promises.readdir(this.mapsDir);

        const cachedMapFiles = await api.cacheDb.selectFrom("map").select(["fileName"]).execute();
        const cachedMapFileNames = cachedMapFiles.map((file) => file.fileName);

        const erroredMapFiles = await api.cacheDb.selectFrom("mapError").select(["fileName"]).execute();
        const erroredMapFileNames = erroredMapFiles.map((file) => file.fileName);

        const mapFilesToCache = mapFiles.filter((file) => !cachedMapFileNames.includes(file) && !erroredMapFileNames.includes(file));

        for (const mapFileToCache of mapFilesToCache) {
            this.mapCacheQueue.add(mapFileToCache);
        }
    }

    protected async cacheMaps() {
        if (this.cachingMaps) {
            console.warn("Don't call cacheReplays more than once");
            return;
        }

        this.cachingMaps = true;

        // eslint-disable-next-line no-constant-condition
        while (true) {
            const [replayToCache] = this.mapCacheQueue;

            if (replayToCache) {
                await this.cacheMap(replayToCache);
            } else {
                await delay(500);
            }
        }
    }

    protected async cacheMap(mapFileName: string) {
        try {
            const fileName = path.parse(mapFileName).name;

            const existingCachedMap = await api.cacheDb.selectFrom("map").select("mapId").where("fileName", "=", fileName).executeTakeFirst();
            if (existingCachedMap || this.installedMaps.some((map) => map.fileName === mapFileName)) {
                console.debug(`${fileName} already cached`);
                this.mapCacheQueue.delete(mapFileName);
                return;
            }

            console.debug(`Caching: ${mapFileName}`);
            console.time(`Cached: ${mapFileName}`);

            const mapPath = path.join(this.mapsDir, mapFileName);

            const parsedMap = await this.parseMap(mapPath, this.mapImagesDir, this.path7za);

            const mapData = await api.cacheDb
                .insertInto("map")
                .values(parsedMap)
                .onConflict((oc) => {
                    const { scriptName, fileName, ...nonUniqueValues } = parsedMap;
                    return oc.doUpdateSet(nonUniqueValues);
                })
                .returningAll()
                .executeTakeFirst();

            if (mapData) {
                this.installedMaps.push(mapData);
                this.onMapCached.dispatch(mapData);
            }
        } catch (err) {
            console.error(`Error parsing map: ${mapFileName}`, err);

            await api.cacheDb
                .insertInto("mapError")
                .onConflict((oc) => oc.doNothing())
                .values({ fileName: mapFileName })
                .execute();
        }

        console.timeEnd(`Cached: ${mapFileName}`);

        this.mapCacheQueue.delete(mapFileName);
    }

    protected mapCached(mapName: string) {
        return new Promise<Selectable<MapData>>((resolve) => {
            this.onMapCached.addOnce((map) => {
                if (map.scriptName === mapName) {
                    resolve(map);
                }
            });
        });
    }

    protected async uncacheMap(name: { fileName: string } | { scriptName: string }) {
        let map: Selectable<MapData> | undefined;
        if ("fileName" in name) {
            map = await api.cacheDb.selectFrom("map").selectAll().where("fileName", "=", name.fileName).executeTakeFirst();
        } else {
            map = await api.cacheDb.selectFrom("map").selectAll().where("scriptName", "=", name.scriptName).executeTakeFirst();
        }

        if (!map) {
            return;
        }

        const mapImages = this.getMapImages({ map });

        await fs.promises.rm(mapImages.textureImagePath, { force: true });
        await fs.promises.rm(mapImages.heightImagePath, { force: true });
        await fs.promises.rm(mapImages.metalImagePath, { force: true });
        await fs.promises.rm(mapImages.typeImagePath, { force: true });

        await api.cacheDb.deleteFrom("map").where("mapId", "=", map.mapId).execute();
    }
}
