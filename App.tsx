import { useState } from "react";
import { Button, Text, View, StyleSheet, ScrollView } from "react-native";
import { StatusBar } from "expo-status-bar";
import { File, Paths } from "expo-file-system";
import {
    cacheDirectory,
    createDownloadResumable,
    DownloadResumable,
} from "expo-file-system/legacy";
import { fetch as expoFetch } from "expo/fetch";

// Any large file URL works. ~100MB is enough to trigger OOM on most devices.
const LARGE_FILE_URL =
    "https://download.blender.org/demo/movies/BBB/bbb_sunflower_1080p_30fps_normal.mp4.zip";

type SectionState = {
    status: string;
    md5: string;
};

const initialState: SectionState = { status: "Idle", md5: "" };

export default function App() {
    const [legacyNoMd5, setLegacyNoMd5] = useState<SectionState>(initialState);
    const [legacyWithMd5, setLegacyWithMd5] =
        useState<SectionState>(initialState);
    const [modernNoMd5, setModernNoMd5] = useState<SectionState>(initialState);
    const [modernWithMd5, setModernWithMd5] =
        useState<SectionState>(initialState);

    const [legacyDownload1, setLegacyDownload1] =
        useState<DownloadResumable | null>(null);
    const [legacyDownload2, setLegacyDownload2] =
        useState<DownloadResumable | null>(null);
    const [modernAbort1, setModernAbort1] = useState<AbortController | null>(
        null,
    );
    const [modernAbort2, setModernAbort2] = useState<AbortController | null>(
        null,
    );

    const doLegacyDownload = async (
        filename: string,
        computeMd5: boolean,
        setState: (s: SectionState) => void,
        setDl: (d: DownloadResumable | null) => void,
    ) => {
        setState({ status: "Downloading...", md5: "" });
        try {
            const fileUri = cacheDirectory + filename;
            const dl = createDownloadResumable(LARGE_FILE_URL, fileUri);
            setDl(dl);
            const result = await dl.downloadAsync();
            if (!result || result.status >= 300) {
                setState({ status: `Error: HTTP ${result?.status}`, md5: "" });
                return;
            }
            const file = new File(Paths.cache, filename);
            const md5 = computeMd5 ? file.md5 : "";
            setState({
                status: `Done! Size: ${file.size} bytes`,
                md5,
            });
        } catch (e: any) {
            setState({ status: `Error: ${e.message}`, md5: "" });
        } finally {
            setDl(null);
        }
    };

    const doModernDownload = async (
        filename: string,
        computeMd5: boolean,
        setState: (s: SectionState) => void,
        setAbort: (a: AbortController | null) => void,
    ) => {
        const controller = new AbortController();
        setAbort(controller);
        setState({ status: "Downloading...", md5: "" });
        try {
            const response = await expoFetch(LARGE_FILE_URL, {
                signal: controller.signal,
            });
            const file = new File(Paths.cache, filename);
            if (file.exists) file.delete();
            file.create();
            const writer = file.writableStream().getWriter();
            const reader = response.body?.getReader();
            if (!reader) {
                setState({ status: "Error: No response body reader", md5: "" });
                return;
            }
            let bytesWritten = 0;
            while (true) {
                const { done, value } = await reader.read();
                if (done) {
                    await writer.close();
                    break;
                }
                await writer.write(value);
                bytesWritten += value.byteLength;
                if (bytesWritten % (5 * 1024 * 1024) < value.byteLength) {
                    setState({
                        status: `Downloaded ${(bytesWritten / 1024 / 1024).toFixed(1)} MB...`,
                        md5: "",
                    });
                }
            }
            const md5 = computeMd5 ? file.md5 : "";
            setState({
                status: `Done! Size: ${file.size} bytes`,
                md5,
            });
        } catch (e: any) {
            if (e.name === "AbortError") {
                setState({ status: "Download aborted", md5: "" });
            } else {
                setState({ status: `Error: ${e.message}`, md5: "" });
            }
        } finally {
            setAbort(null);
        }
    };

    return (
        <ScrollView contentContainerStyle={styles.container}>
            <StatusBar style="auto" />
            <Text style={styles.title}>expo-file-system OOM Repro</Text>

            <Section
                label="1. Legacy — without MD5"
                state={legacyNoMd5}
                onDownload={() =>
                    doLegacyDownload(
                        "legacy-no-md5.zip",
                        false,
                        setLegacyNoMd5,
                        setLegacyDownload1,
                    )
                }
                onCancel={async () => {
                    await legacyDownload1?.cancelAsync();
                    setLegacyDownload1(null);
                    setLegacyNoMd5({ status: "Cancelled", md5: "" });
                }}
            />

            <Section
                label="2. Legacy — with MD5"
                state={legacyWithMd5}
                onDownload={() =>
                    doLegacyDownload(
                        "legacy-with-md5.zip",
                        true,
                        setLegacyWithMd5,
                        setLegacyDownload2,
                    )
                }
                onCancel={async () => {
                    await legacyDownload2?.cancelAsync();
                    setLegacyDownload2(null);
                    setLegacyWithMd5({ status: "Cancelled", md5: "" });
                }}
            />

            <Section
                label="3. Modern (fetch + writableStream) — without MD5"
                state={modernNoMd5}
                onDownload={() =>
                    doModernDownload(
                        "modern-no-md5.zip",
                        false,
                        setModernNoMd5,
                        setModernAbort1,
                    )
                }
                onCancel={() => {
                    modernAbort1?.abort();
                    setModernAbort1(null);
                }}
            />

            <Section
                label="4. Modern (fetch + writableStream) — with MD5"
                state={modernWithMd5}
                onDownload={() =>
                    doModernDownload(
                        "modern-with-md5.zip",
                        true,
                        setModernWithMd5,
                        setModernAbort2,
                    )
                }
                onCancel={() => {
                    modernAbort2?.abort();
                    setModernAbort2(null);
                }}
            />
        </ScrollView>
    );
}

function Section({
    label,
    state,
    onDownload,
    onCancel,
}: {
    label: string;
    state: SectionState;
    onDownload: () => void;
    onCancel: () => void;
}) {
    return (
        <View style={styles.section}>
            <Text style={styles.heading}>{label}</Text>
            <Text style={styles.status}>{state.status}</Text>
            {state.md5 ? (
                <Text style={styles.hash}>MD5: {state.md5}</Text>
            ) : null}
            <View style={styles.buttons}>
                <Button title="Download" onPress={onDownload} />
                <Button title="Cancel" onPress={onCancel} color="red" />
            </View>
        </View>
    );
}

const styles = StyleSheet.create({
    container: {
        flexGrow: 1,
        justifyContent: "center",
        alignItems: "center",
        padding: 24,
        backgroundColor: "#fff",
    },
    title: {
        fontSize: 22,
        fontWeight: "bold",
        marginBottom: 24,
    },
    section: {
        backgroundColor: "#f5f5f5",
        padding: 16,
        borderRadius: 8,
        marginBottom: 16,
        width: "100%",
        gap: 8,
    },
    heading: {
        fontSize: 16,
        fontWeight: "600",
    },
    status: {
        fontSize: 14,
        color: "#333",
    },
    hash: {
        fontSize: 14,
        fontFamily: "monospace",
        color: "#007AFF",
    },
    buttons: {
        gap: 8,
    },
});
