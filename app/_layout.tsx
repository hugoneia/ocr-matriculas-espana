import "@/global.css";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Stack } from "expo-router";
import { Alert } from "react-native";
import { useShareIntentContext } from "expo-share-intent";

import { ShareIntentProvider } from "expo-share-intent";
import { StatusBar } from "expo-status-bar";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import "react-native-reanimated";
import { Platform } from "react-native";
import "@/lib/_core/nativewind-pressable";
import { ThemeProvider } from "@/lib/theme-provider";
import {
  SafeAreaFrameContext,
  SafeAreaInsetsContext,
  SafeAreaProvider,
  initialWindowMetrics,
} from "react-native-safe-area-context";
import type { EdgeInsets, Metrics, Rect } from "react-native-safe-area-context";

import { trpc, createTRPCClient } from "@/lib/trpc";
import { initManusRuntime, subscribeSafeAreaInsets } from "@/lib/_core/manus-runtime";
import { getImportedPlates, importPlatesCSV } from "@/utils/import-plates-csv";

const DEFAULT_WEB_INSETS: EdgeInsets = { top: 0, right: 0, bottom: 0, left: 0 };
const DEFAULT_WEB_FRAME: Rect = { x: 0, y: 0, width: 0, height: 0 };

export const unstable_settings = {
  anchor: "(tabs)",
};

function RootLayoutContent() {
  const { isReady, hasShareIntent, shareIntent, resetShareIntent } = useShareIntentContext();
  const processedListShareRef = useRef<string | null>(null);

  useEffect(() => {
    if (!hasShareIntent) {
      processedListShareRef.current = null;
      return;
    }

    if (!isReady) return;

    const sharedFile = shareIntent.files?.find((file) =>
      file.fileName?.toLowerCase().endsWith(".csv") ||
      file.mimeType?.toLowerCase().includes("csv")
    );

    if (!sharedFile) {
      resetShareIntent();
      return;
    }

    const key = `${sharedFile.path}:${sharedFile.fileName}`;
    if (processedListShareRef.current === key) return;
    processedListShareRef.current = key;

    void (async () => {
      try {
        const currentPlates = await getImportedPlates();
        const hasExistingPlates = Object.keys(currentPlates).length > 0;

        Alert.alert(
          "CSV recibido",
          hasExistingPlates
            ? "El archivo contiene una lista de matrículas. Si continúas, sustituirá la lista de cotejo actual. ¿Deseas reemplazarla?"
            : "Se ha recibido una lista de matrículas. ¿Deseas importarla?",
          [
            {
              text: "Cancelar",
              style: "cancel",
              onPress: () => resetShareIntent(),
            },
            {
              text: hasExistingPlates ? "Reemplazar" : "Importar",
              onPress: async () => {
                try {
                  const result = await importPlatesCSV({
                    uri: sharedFile.path,
                    name: sharedFile.fileName || "archivo.csv",
                  });

                  if (result) {
                    Alert.alert(
                      "Éxito",
                      `Se importaron ${Object.keys(result.newImportedPlates).length} matrículas correctamente (+${result.newCount} nuevas).`,
                    );
                  }
                } catch (error) {
                  console.error("Error importing CSV:", error);
                  Alert.alert("Error", "No se pudo importar el archivo CSV.");
                } finally {
                  resetShareIntent();
                }
              },
            },
          ],
          { cancelable: false },
        );
      } catch (error) {
        console.error("Error checking imported plates:", error);
        Alert.alert("Error", "No se pudo comprobar la lista de matrículas.");
        resetShareIntent();
      }
    })();
  }, [
    isReady,
    hasShareIntent,
    shareIntent.files,
    resetShareIntent,
  ]);
  const initialInsets = initialWindowMetrics?.insets ?? DEFAULT_WEB_INSETS;
  const initialFrame = initialWindowMetrics?.frame ?? DEFAULT_WEB_FRAME;

  const [insets, setInsets] = useState<EdgeInsets>(initialInsets);
  const [frame, setFrame] = useState<Rect>(initialFrame);
  // Initialize Manus runtime for cookie injection from parent container
  useEffect(() => {
    initManusRuntime();
  }, []);

  const handleSafeAreaUpdate = useCallback((metrics: Metrics) => {
    setInsets(metrics.insets);
    setFrame(metrics.frame);
  }, []);

  useEffect(() => {
    if (Platform.OS !== "web") return;
    const unsubscribe = subscribeSafeAreaInsets(handleSafeAreaUpdate);
    return () => unsubscribe();
  }, [handleSafeAreaUpdate]);

  // Create clients once and reuse them
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            // Disable automatic refetching on window focus for mobile
            refetchOnWindowFocus: false,
            // Retry failed requests once
            retry: 1,
          },
        },
      }),
  );
  const [trpcClient] = useState(() => createTRPCClient());

  // Ensure minimum 8px padding for top and bottom on mobile
  const providerInitialMetrics = useMemo(() => {
    const metrics = initialWindowMetrics ?? { insets: initialInsets, frame: initialFrame };
    return {
      ...metrics,
      insets: {
        ...metrics.insets,
        top: Math.max(metrics.insets.top, 16),
        bottom: Math.max(metrics.insets.bottom, 12),
      },
    };
  }, [initialInsets, initialFrame]);

  const content = (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <trpc.Provider client={trpcClient} queryClient={queryClient}>
        <QueryClientProvider client={queryClient}>
          {/* Default to hiding native headers so raw route segments don't appear (e.g. "(tabs)", "products/[id]"). */}
          {/* If a screen needs the native header, explicitly enable it and set a human title via Stack.Screen options. */}
          {/* in order for ios apps tab switching to work properly, use presentation: "fullScreenModal" for login page, whenever you decide to use presentation: "modal*/}
          <Stack screenOptions={{ headerShown: false }}>
            <Stack.Screen name="(tabs)" />
            <Stack.Screen name="oauth/callback" />
          </Stack>
          <StatusBar style="auto" />
        </QueryClientProvider>
      </trpc.Provider>
    </GestureHandlerRootView>
  );

  const shouldOverrideSafeArea = Platform.OS === "web";

  if (shouldOverrideSafeArea) {
    return (
      <ThemeProvider>
        <SafeAreaProvider initialMetrics={providerInitialMetrics}>
          <SafeAreaFrameContext.Provider value={frame}>
            <SafeAreaInsetsContext.Provider value={insets}>
              {content}
            </SafeAreaInsetsContext.Provider>
          </SafeAreaFrameContext.Provider>
        </SafeAreaProvider>
      </ThemeProvider>
    );
  }

  return (
    <ThemeProvider>
      <SafeAreaProvider initialMetrics={providerInitialMetrics}>{content}</SafeAreaProvider>
    </ThemeProvider>
  );
}


export default function RootLayout() {
  return (
    <ShareIntentProvider options={{ resetOnBackground: false }}>
      <RootLayoutContent />
    </ShareIntentProvider>
  );
}
