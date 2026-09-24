import React, { useCallback, useState } from 'react';
import { Alert, KeyboardAvoidingView, Modal, Platform, ScrollView, StyleSheet, Switch, Text, TextInput, TouchableOpacity, View } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import MaterialIcons from '@expo/vector-icons/MaterialIcons';
import { useFocusEffect } from 'expo-router';
import * as DocumentPicker from 'expo-document-picker';
import { File, Paths } from 'expo-file-system';
import * as MediaLibrary from 'expo-media-library';
import * as Sharing from 'expo-sharing';

import { ScreenContainer } from '@/components/screen-container';
import { DEFAULT_SCANNER_SETTINGS, loadScannerSettings, normalizeScannerSettings, saveScannerSettings, type ScannerSettings } from '@/lib/scanner-settings';

const NOTIFICATION_RULES_STORAGE_KEY = 'notification_rules';
const GLOBAL_NOTIFICATIONS_KEY = 'global_notifications_active';
const SAVE_DETECTION_IMAGE_STORAGE_KEY = 'save_detection_image';
const SPECIAL_ALERT_PLACEHOLDER = '¡Matrícula especial detectada!';
const ALERTS_EXPORT_FILE_NAME = 'alertas_personalizadas.json';

interface NotificationRule {
  plate: string;
  message: string;
  active: boolean;
}

interface TimeInputs {
  videoIntervalSeconds: string;
  duplicateWindowSeconds: string;
  standardToastDurationSeconds: string;
  customToastDurationSeconds: string;
  gpsUpdateIntervalSeconds: string;
}

function toTimeInputs(settings: ScannerSettings): TimeInputs {
  return {
    videoIntervalSeconds: String(settings.videoIntervalSeconds),
    duplicateWindowSeconds: String(settings.duplicateWindowSeconds),
    standardToastDurationSeconds: String(settings.standardToastDurationSeconds),
    customToastDurationSeconds: String(settings.customToastDurationSeconds),
    gpsUpdateIntervalSeconds: String(settings.gpsUpdateIntervalSeconds),
  };
}

export default function AjustesScreen() {
  const [notificationRules, setNotificationRules] = useState<Record<string, NotificationRule>>({});
  const [globalNotificationsActive, setGlobalNotificationsActive] = useState(true);
  const [saveDetectionImageEnabled, setSaveDetectionImageEnabled] = useState(false);
  const [timeInputs, setTimeInputs] = useState<TimeInputs>(toTimeInputs(DEFAULT_SCANNER_SETTINGS));
  const [showNotificationModal, setShowNotificationModal] = useState(false);
  const [editingPlate, setEditingPlate] = useState('');
  const [notificationMessage, setNotificationMessage] = useState('');
  const [isRuleActive, setIsRuleActive] = useState(true);

  useFocusEffect(
    useCallback(() => {
      void loadNotificationSettings();
      void loadTimeSettings();
      void loadSaveDetectionImageSetting();
    }, []),
  );

  const loadNotificationSettings = async () => {
    try {
      const storedRules = await AsyncStorage.getItem(NOTIFICATION_RULES_STORAGE_KEY);
      setNotificationRules(storedRules ? JSON.parse(storedRules) : {});
      const storedGlobal = await AsyncStorage.getItem(GLOBAL_NOTIFICATIONS_KEY);
      setGlobalNotificationsActive(storedGlobal === null ? true : JSON.parse(storedGlobal));
    } catch (error) {
      console.error('Error loading notification settings:', error);
    }
  };

  const loadTimeSettings = async () => setTimeInputs(toTimeInputs(await loadScannerSettings()));

  const loadSaveDetectionImageSetting = async () => {
    try {
      const stored = await AsyncStorage.getItem(SAVE_DETECTION_IMAGE_STORAGE_KEY);
      setSaveDetectionImageEnabled(stored === 'true');
    } catch (error) {
      console.error('Error loading image saving setting:', error);
    }
  };

  const handleToggleSaveDetectionImage = async (value: boolean) => {
    if (!value) {
      try {
        await AsyncStorage.setItem(SAVE_DETECTION_IMAGE_STORAGE_KEY, 'false');
        setSaveDetectionImageEnabled(false);
      } catch (error) {
        console.error('Error disabling detection image saving:', error);
        Alert.alert('Error', 'No se pudo guardar el ajuste.');
      }
      return;
    }

    try {
      const permission = await MediaLibrary.getPermissionsAsync(true, ['photo']);
      let permissionGranted = permission.status === 'granted';

      if (!permissionGranted) {
        const requested = await MediaLibrary.requestPermissionsAsync(true, ['photo']);
        permissionGranted = requested.status === 'granted';
      }

      if (!permissionGranted) {
        setSaveDetectionImageEnabled(false);
        Alert.alert(
          'Permiso necesario',
          'Para guardar las capturas de detección debes permitir el acceso a las fotos.',
        );
        return;
      }

      await AsyncStorage.setItem(SAVE_DETECTION_IMAGE_STORAGE_KEY, 'true');
      setSaveDetectionImageEnabled(true);
    } catch (error) {
      console.error('Error enabling detection image saving:', error);
      setSaveDetectionImageEnabled(false);
      Alert.alert('Error', 'No se pudo activar el guardado de capturas.');
    }
  };

  const handleExportAlerts = async () => {
    try {
      const file = new File(Paths.cache, ALERTS_EXPORT_FILE_NAME);
      await file.write(JSON.stringify(notificationRules, null, 2));

      const available = await Sharing.isAvailableAsync();
      if (!available) {
        Alert.alert('Error', 'La función de compartir no está disponible en este dispositivo.');
        return;
      }

      await Sharing.shareAsync(file.uri, {
        mimeType: 'application/json',
        dialogTitle: 'Exportar Alertas',
      });
    } catch (error) {
      console.error('Error exporting notification rules:', error);
      Alert.alert('Error', 'No se pudieron exportar las alertas.');
    }
  };

  const handleImportAlerts = async () => {
    try {
      const result = await DocumentPicker.getDocumentAsync({
        type: 'application/json',
        copyToCacheDirectory: true,
      });

      if (result.canceled || result.assets.length === 0) return;

      const content = await new File(result.assets[0].uri).text();
      const parsed = JSON.parse(content) as unknown;

      const importedRules: Record<string, NotificationRule> = {};

      if (Array.isArray(parsed)) {
        for (const entry of parsed) {
          if (!entry || typeof entry !== 'object') continue;

          const candidate = entry as Partial<NotificationRule>;
          const plate = typeof candidate.plate === 'string'
            ? candidate.plate.trim().toUpperCase()
            : '';
          const message = typeof candidate.message === 'string'
            ? candidate.message.trim()
            : '';

          if (!plate || !message) continue;

          importedRules[plate] = {
            plate,
            message,
            active: candidate.active !== false,
          };
        }
      } else if (parsed && typeof parsed === 'object') {
        for (const [rawPlate, rawRule] of Object.entries(parsed)) {
          if (!rawRule || typeof rawRule !== 'object') continue;

          const candidate = rawRule as Partial<NotificationRule>;
          const plate = (
            typeof candidate.plate === 'string'
              ? candidate.plate
              : rawPlate
          ).trim().toUpperCase();
          const message = typeof candidate.message === 'string'
            ? candidate.message.trim()
            : '';

          if (!plate || !message) continue;

          importedRules[plate] = {
            plate,
            message,
            active: candidate.active !== false,
          };
        }
      }

      const importedCount = Object.keys(importedRules).length;

      if (importedCount === 0) {
        Alert.alert('Importación', 'El archivo no contiene alertas válidas.');
        return;
      }

      const mergedRules = {
        ...notificationRules,
        ...importedRules,
      };

      await saveNotificationSettings(
        mergedRules,
        globalNotificationsActive,
      );

      Alert.alert(
        'Alertas importadas',
        `Se han importado ${importedCount} alerta${importedCount === 1 ? '' : 's'}.`,
      );
    } catch (error) {
      console.error('Error importing notification rules:', error);
      Alert.alert(
        'Error',
        'No se pudo importar el archivo de alertas. Comprueba que sea un JSON válido.',
      );
    }
  };

  const saveNotificationSettings = async (newRules: Record<string, NotificationRule>, globalActive: boolean) => {
    try {
      await AsyncStorage.setItem(NOTIFICATION_RULES_STORAGE_KEY, JSON.stringify(newRules));
      await AsyncStorage.setItem(GLOBAL_NOTIFICATIONS_KEY, JSON.stringify(globalActive));
      setNotificationRules(newRules);
      setGlobalNotificationsActive(globalActive);
    } catch (error) {
      console.error('Error saving notification settings:', error);
      Alert.alert('Error', 'No se pudo guardar la configuración de notificaciones.');
    }
  };

  const handleSaveTimes = async () => {
    try {
      const settings = normalizeScannerSettings({
        videoIntervalSeconds: Number(timeInputs.videoIntervalSeconds),
        duplicateWindowSeconds: Number(timeInputs.duplicateWindowSeconds),
        standardToastDurationSeconds: Number(timeInputs.standardToastDurationSeconds),
        customToastDurationSeconds: Number(timeInputs.customToastDurationSeconds),
        gpsUpdateIntervalSeconds: Number(timeInputs.gpsUpdateIntervalSeconds),
      });
      const saved = await saveScannerSettings(settings);
      setTimeInputs(toTimeInputs(saved));
      Alert.alert('Tiempos guardados', 'Los nuevos tiempos se aplicarán en Cámara al volver a esa pestaña.');
    } catch (error) {
      console.error('Error saving scanner settings:', error);
      Alert.alert('Error', 'No se pudieron guardar los tiempos.');
    }
  };

  const handleToggleRuleActive = (plate: string) => {
    const current = notificationRules[plate];
    if (!current) return;
    void saveNotificationSettings({ ...notificationRules, [plate]: { ...current, active: !current.active } }, globalNotificationsActive);
  };

  const handleDeleteRule = (plate: string) => {
    Alert.alert('Eliminar Notificación', `¿Deseas eliminar la regla de notificación para ${plate}?`, [
      { text: 'Cancelar', style: 'cancel' },
      {
        text: 'Eliminar',
        style: 'destructive',
        onPress: () => {
          const updated = { ...notificationRules };
          delete updated[plate];
          void saveNotificationSettings(updated, globalNotificationsActive);
        },
      },
    ]);
  };

  const handleOpenEditRule = (plate: string) => {
    const existing = notificationRules[plate];
    setEditingPlate(plate);
    setNotificationMessage(existing?.message ?? '');
    setIsRuleActive(existing?.active ?? true);
    setShowNotificationModal(true);
  };

  const handleSaveRule = () => {
    const plate = editingPlate.trim().toUpperCase();
    if (!plate) {
      Alert.alert('Error', 'La matrícula no puede estar vacía.');
      return;
    }

    void saveNotificationSettings({
      ...notificationRules,
      [plate]: { plate, message: notificationMessage.trim() || SPECIAL_ALERT_PLACEHOLDER, active: isRuleActive },
    }, globalNotificationsActive);
    setShowNotificationModal(false);
  };

  return (
    <ScreenContainer className="flex-1 p-4">
      <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        <View style={styles.section}>
          <View style={styles.titleRow}>
            <MaterialIcons name="timer" size={22} color="#007AFF" />
            <Text style={styles.sectionTitle}>Tiempos de Escaneo</Text>
          </View>
          <Text style={styles.helpText}>Personaliza cada intervalo en segundos. Los valores se aplican al volver a Cámara.</Text>
          <View style={styles.timeField}>
            <Text style={styles.timeLabel}>Captura entre fotogramas (Vídeo)</Text>
            <TextInput style={styles.timeInput} value={timeInputs.videoIntervalSeconds} onChangeText={(value) => setTimeInputs((current) => ({ ...current, videoIntervalSeconds: value }))} keyboardType="decimal-pad" />
          </View>
          <View style={styles.timeField}>
            <Text style={styles.timeLabel}>Ignorar duplicados</Text>
            <TextInput style={styles.timeInput} value={timeInputs.duplicateWindowSeconds} onChangeText={(value) => setTimeInputs((current) => ({ ...current, duplicateWindowSeconds: value }))} keyboardType="decimal-pad" />
          </View>
          <View style={styles.timeField}>
            <Text style={styles.timeLabel}>Duración toast estándar</Text>
            <TextInput style={styles.timeInput} value={timeInputs.standardToastDurationSeconds} onChangeText={(value) => setTimeInputs((current) => ({ ...current, standardToastDurationSeconds: value }))} keyboardType="decimal-pad" />
          </View>
          <View style={styles.timeField}>
            <Text style={styles.timeLabel}>Duración alerta personalizada</Text>
            <TextInput style={styles.timeInput} value={timeInputs.customToastDurationSeconds} onChangeText={(value) => setTimeInputs((current) => ({ ...current, customToastDurationSeconds: value }))} keyboardType="decimal-pad" />
          </View>
          <View style={styles.timeField}>
            <Text style={styles.timeLabel}>Intervalo de actualización GPS</Text>
            <TextInput style={styles.timeInput} value={timeInputs.gpsUpdateIntervalSeconds} onChangeText={(value) => setTimeInputs((current) => ({ ...current, gpsUpdateIntervalSeconds: value }))} keyboardType="decimal-pad" />
          </View>
          <TouchableOpacity style={styles.button} onPress={() => void handleSaveTimes()}>
            <Text style={styles.buttonText}>Guardar tiempos</Text>
          </TouchableOpacity>
        </View>

        <View style={styles.section}>
          <View style={styles.titleRow}>
            <MaterialIcons name="photo-camera" size={22} color="#007AFF" />
            <Text style={styles.sectionTitle}>Guardar captura de detección</Text>
          </View>

          <Text style={styles.helpText}>
            Guarda automáticamente en Fotos una evidencia de cada matrícula detectada que tenga coincidencia en el registro.
          </Text>

          <View style={styles.globalToggleRow}>
            <Text style={styles.globalToggleLabel}>Guardar capturas</Text>
            <Switch
              value={saveDetectionImageEnabled}
              onValueChange={(value) => void handleToggleSaveDetectionImage(value)}
            />
          </View>
        </View>

        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Gestión de Alertas y Notificaciones</Text>
          <View style={styles.globalToggleRow}>
            <Text style={styles.globalToggleLabel}>Activar Notificaciones Globales</Text>
            <Switch value={globalNotificationsActive} onValueChange={(value) => void saveNotificationSettings(notificationRules, value)} />
          </View>

          <View style={styles.alertManagementButtons}>
            <TouchableOpacity
              style={[styles.button, styles.buttonSecondary, styles.halfButton]}
              onPress={() => void handleImportAlerts()}
            >
              <Text style={styles.buttonText}>Importar Alertas</Text>
            </TouchableOpacity>

            <TouchableOpacity
              style={[styles.button, styles.buttonSecondary, styles.halfButton]}
              onPress={() => void handleExportAlerts()}
            >
              <Text style={styles.buttonText}>Exportar Alertas</Text>
            </TouchableOpacity>
          </View>

          <TouchableOpacity
            style={[styles.button, styles.buttonPurple]}
            onPress={() => {
              setEditingPlate('');
              setNotificationMessage('');
              setIsRuleActive(true);
              setShowNotificationModal(true);
            }}
          >
            <Text style={styles.buttonText}>+ Añadir Alerta de Matrícula</Text>
          </TouchableOpacity>

          {Object.keys(notificationRules).length > 0 ? (
            <View style={styles.rulesList}>
              <Text style={styles.subSectionTitle}>Matrículas con Alerta Configurada:</Text>
              {Object.entries(notificationRules).map(([plate, rule]) => (
                <View key={plate} style={styles.ruleItem}>
                  <View style={styles.ruleCopy}>
                    <Text style={styles.rulePlate}>{rule.plate}</Text>
                    <Text style={styles.ruleMessage} numberOfLines={1}>{rule.message}</Text>
                  </View>
                  <Switch value={rule.active} onValueChange={() => handleToggleRuleActive(rule.plate)} style={styles.ruleSwitch} />
                  <TouchableOpacity onPress={() => handleOpenEditRule(rule.plate)} style={styles.iconButton}><MaterialIcons name="edit" size={20} color="#007AFF" /></TouchableOpacity>
                  <TouchableOpacity onPress={() => handleDeleteRule(rule.plate)} style={styles.iconButton}><MaterialIcons name="delete" size={20} color="#FF3B30" /></TouchableOpacity>
                </View>
              ))}
            </View>
          ) : <Text style={styles.emptyText}>No hay reglas de notificación configuradas.</Text>}
        </View>
      </ScrollView>

      <Modal visible={showNotificationModal} animationType="slide" transparent onRequestClose={() => setShowNotificationModal(false)}>
        <KeyboardAvoidingView style={styles.modalOverlay} behavior={Platform.OS === 'ios' ? 'padding' : 'height'} keyboardVerticalOffset={24}>
          <ScrollView contentContainerStyle={styles.modalScrollContent} keyboardShouldPersistTaps="handled">
            <View style={styles.modalContent}>
              <Text style={styles.modalTitleText}>Configurar Alerta de Matrícula</Text>
              <Text style={styles.inputLabel}>Matrícula:</Text>
              <TextInput style={styles.textInput} placeholder="Ej: 1234ABC" value={editingPlate} onChangeText={setEditingPlate} autoCapitalize="characters" />
              <Text style={styles.inputLabel}>Texto de Notificación (Toast):</Text>
              <TextInput style={[styles.textInput, styles.messageInput]} placeholder={SPECIAL_ALERT_PLACEHOLDER} value={notificationMessage} onChangeText={setNotificationMessage} multiline />
              <View style={styles.globalToggleRow}>
                <Text style={styles.globalToggleLabel}>Alerta Activa</Text>
                <Switch value={isRuleActive} onValueChange={setIsRuleActive} />
              </View>
              <View style={styles.modalButtonsRow}>
                <TouchableOpacity style={[styles.modalButton, styles.modalButtonCancel]} onPress={() => setShowNotificationModal(false)}><Text style={styles.modalButtonText}>Cancelar</Text></TouchableOpacity>
                <TouchableOpacity style={[styles.modalButton, styles.modalButtonSave]} onPress={handleSaveRule}><Text style={styles.modalButtonText}>Guardar</Text></TouchableOpacity>
              </View>
            </View>
          </ScrollView>
        </KeyboardAvoidingView>
      </Modal>
    </ScreenContainer>
  );
}

const styles = StyleSheet.create({
  content: { paddingBottom: 40 },
  section: { marginBottom: 24, backgroundColor: '#fff', padding: 16, borderRadius: 12, shadowColor: '#000', shadowOffset: { width: 0, height: 1 }, shadowOpacity: 0.1, shadowRadius: 2, elevation: 2 },
  titleRow: { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 12 },
  sectionTitle: { fontSize: 18, fontWeight: 'bold', color: '#11181C' },
  subSectionTitle: { fontSize: 14, fontWeight: '600', color: '#687076', marginBottom: 8 },
  helpText: { color: '#687076', fontSize: 13, lineHeight: 18, marginBottom: 12 },
  timeField: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12, paddingVertical: 8, borderBottomColor: '#E5E7EB', borderBottomWidth: 1 },
  timeLabel: { flex: 1, fontSize: 14, color: '#11181C', fontWeight: '600' },
  timeInput: { width: 74, borderWidth: 1, borderColor: '#D1D5DB', borderRadius: 8, paddingVertical: 7, paddingHorizontal: 9, backgroundColor: '#F9FAFB', textAlign: 'center', fontSize: 15 },
  globalToggleRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16, backgroundColor: '#F5F5F5', padding: 12, borderRadius: 8 },
  globalToggleLabel: { fontSize: 15, fontWeight: '600', color: '#11181C', flex: 1, paddingRight: 12 },
  button: { backgroundColor: '#007AFF', paddingVertical: 12, paddingHorizontal: 16, borderRadius: 8, alignItems: 'center', marginTop: 12 },
  buttonPurple: { backgroundColor: '#5856D6', marginTop: 0 },
  buttonSecondary: { backgroundColor: '#5C6BC0', marginTop: 0 },
  alertManagementButtons: { flexDirection: 'row', gap: 10, marginBottom: 12 },
  halfButton: { flex: 1 },
  buttonText: { color: 'white', fontSize: 16, fontWeight: '600' },
  rulesList: { marginTop: 16 },
  ruleItem: { flexDirection: 'row', alignItems: 'center', backgroundColor: '#F8F9FA', padding: 10, borderRadius: 8, marginBottom: 8, borderWidth: 1, borderColor: '#E5E7EB' },
  ruleCopy: { flex: 1 },
  rulePlate: { fontSize: 15, fontWeight: 'bold', color: '#11181C' },
  ruleMessage: { fontSize: 13, color: '#687076' },
  ruleSwitch: { marginRight: 8 },
  iconButton: { padding: 6, marginLeft: 4 },
  emptyText: { fontSize: 14, color: '#687076', fontStyle: 'italic', textAlign: 'center', marginVertical: 8 },
  modalOverlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.5)', paddingHorizontal: 20 },
  modalScrollContent: { flexGrow: 1, justifyContent: 'center', paddingVertical: 24 },
  modalContent: { backgroundColor: 'white', borderRadius: 12, padding: 20, width: '100%', maxWidth: 400, alignSelf: 'center' },
  modalTitleText: { fontSize: 18, fontWeight: 'bold', marginBottom: 16, textAlign: 'center', color: '#11181C' },
  inputLabel: { fontSize: 14, fontWeight: '600', color: '#374151', marginBottom: 6 },
  textInput: { borderWidth: 1, borderColor: '#D1D5DB', borderRadius: 8, padding: 10, fontSize: 15, marginBottom: 16, backgroundColor: '#F9FAFB' },
  messageInput: { height: 80, textAlignVertical: 'top' },
  modalButtonsRow: { flexDirection: 'row', justifyContent: 'space-between', marginTop: 8 },
  modalButton: { flex: 1, paddingVertical: 12, borderRadius: 8, alignItems: 'center', marginHorizontal: 6 },
  modalButtonCancel: { backgroundColor: '#8E8E93' },
  modalButtonSave: { backgroundColor: '#007AFF' },
  modalButtonText: { color: 'white', fontSize: 16, fontWeight: '600' },
});
