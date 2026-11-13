"use client";

import { useEffect, useRef, useState } from "react";
import { FACE_ID_REQUIRED_CAPTURES } from "@/lib/face-id/config";

// Chaves antigas que guardavam descritores faciais em texto puro no navegador. Sao removidas.
const LEGACY_FACE_STORAGE_KEYS = ["orquestracs-face-id-local-profiles", "orquestracs-face-id-remote-descriptors-v1"];
const MATCH_THRESHOLD = 0.5;
const AUTO_RECOGNITION_INTERVAL_MS = 500;
// Prova de presença: o rosto precisa se mover levemente na janela de amostras antes de qualquer match.
const PRESENCE_WINDOW_SIZE = 8;
const PRESENCE_MIN_SAMPLES = 6;
const PRESENCE_MIN_MOVEMENT = 0.05;

type FaceApiModule = typeof import("@vladmandic/face-api");

export type RecognizedFace = {
  employeeId: string;
  name: string;
  externalPunchAllowed?: boolean;
  punchMode?: "automatic" | "manual";
  schedule?: {
    breakEnd: string;
    breakStart: string;
    end: string;
    periods?: Array<{ start: string; end: string }>;
    start: string;
    toleranceMinutes: number;
  };
};

export type FaceProfileSource = RecognizedFace & {
  photoUrl: string;
};

type StoredFaceProfile = RecognizedFace & {
  descriptors: number[][];
  updatedAt: string;
  sourceKey?: string;
};

let faceApiPromise: Promise<FaceApiModule> | null = null;

// Descritores faciais vivem apenas na memória da aba. Nunca são gravados em localStorage.
const localFaceProfiles = new Map<string, StoredFaceProfile>();
const remoteDescriptorCache = new Map<string, StoredFaceProfile>();

if (typeof window !== "undefined") {
  for (const key of LEGACY_FACE_STORAGE_KEYS) window.localStorage.removeItem(key);
}

function loadCachedRemoteProfiles() {
  return Array.from(remoteDescriptorCache.values());
}

function saveCachedRemoteProfiles(profiles: StoredFaceProfile[]) {
  remoteDescriptorCache.clear();
  for (const profile of profiles) {
    if (profile.sourceKey) remoteDescriptorCache.set(profile.sourceKey, profile);
  }
}

type FaceCameraProps = {
  autoRecognize?: boolean;
  autoStart?: boolean;
  compact?: boolean;
  employee?: RecognizedFace;
  recognitionPaused?: boolean;
  registrationAllowed?: boolean;
  onCameraState?: (state: "idle" | "loading" | "ready" | "error") => void;
  onProfileUpdated?: (captureCount: number, photoBlob?: Blob) => void | Promise<void>;
  onRecognized?: (employee: RecognizedFace, photoBlob?: Blob) => void;
  onStatus?: (message: string) => void;
  profileSources?: FaceProfileSource[];
  replaceProfile?: boolean;
  captureRef?: { current: (() => Promise<Blob | undefined>) | null };
};

function getProfiles() {
  return Array.from(localFaceProfiles.values());
}

export function clearLocalFaceProfile(employeeId: string) {
  localFaceProfiles.delete(employeeId);
}

export function FaceCamera({
  autoRecognize = false,
  autoStart = false,
  compact = false,
  employee,
  recognitionPaused = false,
  registrationAllowed = true,
  onCameraState,
  onProfileUpdated,
  onRecognized,
  onStatus,
  profileSources = [],
  replaceProfile = false,
  captureRef,
}: FaceCameraProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const faceApiRef = useRef<FaceApiModule | null>(null);
  const [cameraState, setCameraState] = useState<"idle" | "loading" | "ready" | "error">("idle");
  const [processing, setProcessing] = useState(false);
  const [message, setMessage] = useState("Ative a câmera para começar.");
  const remoteProfilesRef = useRef<StoredFaceProfile[] | null>(null);
  const remoteProfilesPromiseRef = useRef<Promise<StoredFaceProfile[]> | null>(null);
  const remoteProfilesMessageRef = useRef("");
  const replacementStartedRef = useRef(false);
  const startInFlightRef = useRef(false);
  const processingRef = useRef(false);
  const lastRecognitionDescriptorRef = useRef<Float32Array | null>(null);
  const faceAwayFramesRef = useRef(0);
  const lastAutomaticMessageRef = useRef("");
  const presenceSamplesRef = useRef<Array<{ x: number; y: number }>>([]);

  useEffect(() => {
    remoteProfilesRef.current = null;
    remoteProfilesMessageRef.current = "";
  }, [profileSources]);

  useEffect(() => {
    replacementStartedRef.current = false;
  }, [employee?.employeeId, replaceProfile]);

  useEffect(() => {
    onCameraState?.(cameraState);
  }, [cameraState, onCameraState]);

  useEffect(() => {
    if (captureRef) captureRef.current = captureFrame;
  });

  useEffect(() => {
    if (!autoStart || cameraState !== "idle") return;
    void startCamera();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoStart, cameraState]);

  useEffect(() => {
    return () => {
      streamRef.current?.getTracks().forEach((track) => track.stop());
    };
  }, []);

  function updateMessage(value: string) {
    setMessage(value);
    onStatus?.(value);
  }

  function updateAutomaticMessage(value: string) {
    if (lastAutomaticMessageRef.current === value) return;
    lastAutomaticMessageRef.current = value;
    updateMessage(value);
  }

  async function loadFaceApi() {
    if (!faceApiPromise) {
      faceApiPromise = (async () => {
        const faceApi = await import("@vladmandic/face-api");
        await Promise.all([
          faceApi.nets.tinyFaceDetector.loadFromUri("/models/face-api"),
          faceApi.nets.faceLandmark68Net.loadFromUri("/models/face-api"),
          faceApi.nets.faceRecognitionNet.loadFromUri("/models/face-api"),
        ]);
        return faceApi;
      })().catch((error) => {
        faceApiPromise = null;
        throw error;
      });
    }

    const faceApi = await faceApiPromise;
    faceApiRef.current = faceApi;
    return faceApi;
  }

  async function startCamera() {
    if (!navigator.mediaDevices?.getUserMedia) {
      setCameraState("error");
      updateMessage("Este navegador não oferece acesso compatível à câmera.");
      return;
    }

    if (!window.isSecureContext) {
      setCameraState("error");
      updateMessage("A câmera exige HTTPS. Abra o domínio seguro do sistema ou use localhost para testar.");
      return;
    }

    if (startInFlightRef.current || cameraState === "loading" || cameraState === "ready") return;
    startInFlightRef.current = true;

    setCameraState("loading");
    updateMessage("Carregando câmera e reconhecimento...");

    try {
      const [faceApi, stream] = await Promise.all([
        loadFaceApi(),
        navigator.mediaDevices.getUserMedia({
          audio: false,
          video: {
            facingMode: "user",
            width: { ideal: 1280 },
            height: { ideal: 720 },
          },
        }),
      ]);

      streamRef.current?.getTracks().forEach((track) => track.stop());
      streamRef.current = stream;

      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        await videoRef.current.play();
      }

      setCameraState("ready");
      if (profileSources.length) {
        updateMessage("Câmera ativa. Sincronizando rostos cadastrados...");
        const syncedProfiles = await loadRemoteProfiles(faceApi);
        updateMessage(
          syncedProfiles.length
            ? `${syncedProfiles.length} referência(s) facial(is) sincronizada(s). Reconhecimento ativo: fique em frente à câmera.`
            : "Nenhuma referência facial válida foi sincronizada. Verifique o cadastro ou use PIN + foto.",
        );
      } else {
        updateMessage("Câmera ativa, mas nenhum perfil facial foi carregado. Confira empresa e cadastro; use PIN + foto enquanto isso.");
      }
    } catch (error) {
      console.error(error);
      setCameraState("error");
      const errorName = error instanceof DOMException ? error.name : "";
      const errorMessage = {
        NotAllowedError: "A permissão da câmera foi negada. Libere a câmera para este site e tente novamente.",
        NotFoundError: "Nenhuma câmera foi encontrada neste dispositivo. Use um tablet ou celular com câmera.",
        NotReadableError: "A câmera está sendo usada por outro aplicativo. Feche-o e tente novamente.",
        OverconstrainedError: "A câmera deste dispositivo não atende ao formato solicitado. Tente outra câmera.",
        SecurityError: "O navegador bloqueou a câmera por segurança. Use o endereço HTTPS do sistema.",
      }[errorName as "NotAllowedError" | "NotFoundError" | "NotReadableError" | "OverconstrainedError" | "SecurityError"];
      updateMessage(errorMessage || "Não foi possível preparar a câmera. Confira o dispositivo, a permissão e o endereço HTTPS.");
    } finally {
      startInFlightRef.current = false;
    }
  }

  async function readDescriptor() {
    const video = videoRef.current;
    const faceApi = faceApiRef.current;
    if (!video || !faceApi || cameraState !== "ready") return null;

    return faceApi
      .detectSingleFace(
        video,
        new faceApi.TinyFaceDetectorOptions({ inputSize: 320, scoreThreshold: 0.55 }),
      )
      .withFaceLandmarks()
      .withFaceDescriptor();
  }

  async function captureFrame() {
    const video = videoRef.current;
    if (!video || !video.videoWidth || !video.videoHeight) return undefined;

    const canvas = document.createElement("canvas");
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    const context = canvas.getContext("2d");
    if (!context) return undefined;

    context.drawImage(video, 0, 0, canvas.width, canvas.height);
    return new Promise<Blob | undefined>((resolve) => {
      canvas.toBlob((blob) => resolve(blob || undefined), "image/webp", 0.82);
    });
  }

  async function loadRemoteProfiles(faceApi: FaceApiModule) {
    if (remoteProfilesRef.current) return remoteProfilesRef.current;
    if (remoteProfilesPromiseRef.current) return remoteProfilesPromiseRef.current;

    if (!profileSources.length) {
      remoteProfilesRef.current = [];
      remoteProfilesMessageRef.current = "O cadastro aparece como ativo, mas não há fotos faciais vinculadas. Refaça o Face ID do colaborador para sincronizar as imagens.";
      return [];
    }

    const loadPromise = (async () => {
      const cachedProfiles = new Map(
        loadCachedRemoteProfiles().map((profile) => [profile.sourceKey, profile]),
      );
      const syncedProfiles: StoredFaceProfile[] = [];
      let loadFailures = 0;
      let undetectableImages = 0;

      for (let index = 0; index < profileSources.length; index += 4) {
        const batch = await Promise.all(profileSources.slice(index, index + 4).map(async (source) => {
          const sourceKey = `${source.employeeId}|${source.photoUrl}`;
          const cached = cachedProfiles.get(sourceKey);
          if (cached) return { ...cached, ...source, sourceKey };

          try {
            const image = await faceApi.fetchImage(source.photoUrl);
            const detection = await faceApi
              .detectSingleFace(
                image,
                new faceApi.TinyFaceDetectorOptions({ inputSize: 320, scoreThreshold: 0.55 }),
              )
              .withFaceLandmarks()
              .withFaceDescriptor();
            if (!detection) {
              undetectableImages += 1;
              return null;
            }

            return {
              ...source,
              descriptors: [Array.from(detection.descriptor)],
              updatedAt: new Date().toISOString(),
              sourceKey,
            };
          } catch (error) {
            loadFailures += 1;
            console.warn(`Não foi possível sincronizar o rosto de ${source.name}.`, error);
            return null;
          }
        }));
        syncedProfiles.push(...batch.filter((profile) => profile !== null) as StoredFaceProfile[]);
      }

      saveCachedRemoteProfiles(syncedProfiles);
      remoteProfilesRef.current = syncedProfiles;
      if (!syncedProfiles.length && profileSources.length) {
        const status = loadFailures
          ? "Não foi possível baixar as fotos faciais neste aparelho. Confira a conexão e o acesso ao Firebase."
          : undetectableImages
            ? "As fotos chegaram, mas não foi possível identificar rostos nelas. Recadastre o Face ID com imagens nítidas."
            : "O cadastro consta como ativo, mas não há fotos faciais vinculadas. Recadastre o Face ID deste colaborador.";
        remoteProfilesMessageRef.current = status;
        updateMessage(status);
      } else {
        remoteProfilesMessageRef.current = "";
      }
      return syncedProfiles;
    })();
    remoteProfilesPromiseRef.current = loadPromise;
    try {
      return await loadPromise;
    } finally {
      if (remoteProfilesPromiseRef.current === loadPromise) remoteProfilesPromiseRef.current = null;
    }
  }

  async function registerFace() {
    if (!employee) {
      updateMessage("Selecione ou cadastre um colaborador antes da captura facial.");
      return;
    }

    if (!registrationAllowed) {
      updateMessage("Confirme o aceite biometrico antes de capturar o Face ID.");
      return;
    }

    setProcessing(true);
    updateMessage(`Analisando o rosto de ${employee.name}...`);

    try {
      const detection = await readDescriptor();
      if (!detection) {
        updateMessage("Nenhum rosto nítido foi encontrado. Melhore a luz e tente novamente.");
        return;
      }

      const replacingNow = replaceProfile && !replacementStartedRef.current;
      const existing = replacingNow ? null : localFaceProfiles.get(employee.employeeId) || null;
      const descriptors = [
        ...(existing?.descriptors || []),
        Array.from(detection.descriptor),
      ].slice(-FACE_ID_REQUIRED_CAPTURES);
      const profile: StoredFaceProfile = {
        ...employee,
        descriptors,
        updatedAt: new Date().toISOString(),
      };

      replacementStartedRef.current = true;
      localFaceProfiles.set(employee.employeeId, profile);
      try {
        await onProfileUpdated?.(descriptors.length, await captureFrame());
      } catch (error) {
        console.error("Não foi possível sincronizar a captura facial.", error);
        updateMessage("A captura foi feita, mas não foi sincronizada com o sistema. Tente novamente.");
        return;
      }
      updateMessage(
        `${employee.name}: captura ${descriptors.length}/${FACE_ID_REQUIRED_CAPTURES} sincronizada no Firebase.`,
      );
    } finally {
      setProcessing(false);
    }
  }

  function recordPresenceSample(detection: { landmarks: { getNose: () => Array<{ x: number; y: number }> }; detection: { box: { width: number } } }) {
    const nose = detection.landmarks.getNose()[3];
    const width = detection.detection.box.width || 1;
    presenceSamplesRef.current.push({ x: nose.x / width, y: nose.y / width });
    if (presenceSamplesRef.current.length > PRESENCE_WINDOW_SIZE) presenceSamplesRef.current.shift();
  }

  function hasPresenceMovement() {
    const samples = presenceSamplesRef.current;
    if (samples.length < PRESENCE_MIN_SAMPLES) return false;
    const xs = samples.map((sample) => sample.x);
    const ys = samples.map((sample) => sample.y);
    const span = Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys));
    return span >= PRESENCE_MIN_MOVEMENT;
  }

  async function recognizeFace(automatic = false) {
    if (processingRef.current) return;
    processingRef.current = true;
    setProcessing(true);
    if (!automatic) {
      presenceSamplesRef.current = [];
      updateMessage("Comparando o rosto...");
    }

    try {
      const faceApi = faceApiRef.current;
      // Só perfis da empresa ativa (presentes em profileSources) podem ser usados para comparação.
      const allowedEmployeeIds = new Set(profileSources.map((source) => source.employeeId));
      const localProfiles = getProfiles().filter((profile) => allowedEmployeeIds.has(profile.employeeId));
      const profiles = faceApi
        ? [...localProfiles, ...(await loadRemoteProfiles(faceApi))]
        : localProfiles;
      if (!profiles.length) {
        const status = remoteProfilesMessageRef.current || "Nenhum perfil facial sincronizado. Verifique o cadastro do Face ID ou use PIN + foto.";
        if (automatic) updateAutomaticMessage(status);
        else updateMessage(status);
        return;
      }

      if (!automatic && !hasPresenceMovement()) {
        updateMessage("Mova levemente a cabeça para confirmar sua presença...");
        for (let attempt = 0; attempt < PRESENCE_MIN_SAMPLES + 4 && !hasPresenceMovement(); attempt += 1) {
          await new Promise((resolve) => window.setTimeout(resolve, 400));
          const sample = await readDescriptor();
          if (sample) recordPresenceSample(sample);
        }
        if (!hasPresenceMovement()) {
          updateMessage("Presença não confirmada. Olhe para a câmera, mova levemente a cabeça e tente novamente.");
          return;
        }
      }

      const detection = await readDescriptor();
      if (!detection) {
        if (automatic) {
          presenceSamplesRef.current = [];
          updateAutomaticMessage("Reconhecimento ativo. Aguardando um rosto em frente à câmera...");
          faceAwayFramesRef.current += 1;
          if (faceAwayFramesRef.current >= 2) {
            lastRecognitionDescriptorRef.current = null;
            faceAwayFramesRef.current = 0;
          }
        } else {
          updateMessage("Nenhum rosto nítido foi encontrado. Posicione-se no centro.");
        }
        return;
      }

      if (!faceApi) return;
      recordPresenceSample(detection);

      if (automatic && lastRecognitionDescriptorRef.current) {
        const distanceFromPrevious = faceApi.euclideanDistance(
          lastRecognitionDescriptorRef.current,
          detection.descriptor,
        );
        if (distanceFromPrevious < 0.45) {
          faceAwayFramesRef.current = 0;
          return;
        }
        faceAwayFramesRef.current += 1;
        if (faceAwayFramesRef.current < 2) return;
        lastRecognitionDescriptorRef.current = null;
        faceAwayFramesRef.current = 0;
      }

      let bestMatch: { distance: number; profile: StoredFaceProfile } | null = null;

      for (const profile of profiles) {
        for (const savedDescriptor of profile.descriptors) {
          const distance = faceApi.euclideanDistance(
            new Float32Array(savedDescriptor),
            detection.descriptor,
          );
          if (!bestMatch || distance < bestMatch.distance) {
            bestMatch = { distance, profile };
          }
        }
      }

      if (bestMatch && bestMatch.distance <= MATCH_THRESHOLD) {
        const match = bestMatch as { distance: number; profile: StoredFaceProfile };
        if (!hasPresenceMovement()) {
          const status = "Confirme sua presença: mova levemente a cabeça diante da câmera.";
          if (automatic) updateAutomaticMessage(status);
          else updateMessage(status);
          return;
        }
        lastRecognitionDescriptorRef.current = detection.descriptor;
        faceAwayFramesRef.current = 0;
        lastAutomaticMessageRef.current = "";
        updateMessage(
          `${match.profile.name} reconhecido (similaridade técnica: ${Math.round((1 - match.distance) * 100)}%).`,
        );
        onRecognized?.(
          {
            employeeId: match.profile.employeeId,
            name: match.profile.name,
            punchMode: match.profile.punchMode || "automatic",
            schedule: match.profile.schedule,
          },
          await captureFrame(),
        );
      } else {
        const status = "Rosto detectado, mas não reconhecido. Ajuste a posição ou use PIN + foto.";
        if (automatic) updateAutomaticMessage(status);
        else updateMessage(status);
      }
    } catch (error) {
      console.error(error);
      const status = automatic
        ? "Falha ao carregar ou comparar os perfis faciais. Verifique a conexão ou use PIN + foto."
        : "O cadastro facial está inválido. Cadastre o rosto novamente.";
      if (automatic) updateAutomaticMessage(status);
      else updateMessage(status);
    } finally {
      processingRef.current = false;
      setProcessing(false);
    }
  }

  useEffect(() => {
    if (!autoRecognize || cameraState !== "ready" || recognitionPaused) return;

    // Cada reinicio do reconhecimento exige nova prova de presenca.
    presenceSamplesRef.current = [];
    let cancelled = false;
    let timer: number | undefined;

    const loop = async () => {
      if (cancelled) return;
      await recognizeFace(true);
      if (!cancelled) timer = window.setTimeout(loop, AUTO_RECOGNITION_INTERVAL_MS);
    };

    void loop();
    return () => {
      cancelled = true;
      if (timer) window.clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoRecognize, cameraState, profileSources, recognitionPaused]);

  return (
    <div className={`rounded-lg border border-white/10 bg-[#0b121a] ${compact ? "p-3" : "p-5"}`}>
      <div className={`relative overflow-hidden rounded-lg bg-black ${compact ? "min-h-[190px]" : "min-h-[360px]"}`}>
        <video
          aria-label="Visualização da câmera frontal"
          className="h-full min-h-[inherit] w-full object-cover"
          muted
          playsInline
          ref={videoRef}
        />
        {cameraState !== "ready" && (
          <div className="absolute inset-0 grid place-items-center p-6 text-center text-sm text-white/70">
            {cameraState === "loading" ? "Preparando câmera..." : "Câmera desativada"}
          </div>
        )}
        {cameraState === "ready" && (
          <div className="pointer-events-none absolute inset-[12%] rounded-[42%] border-4 border-[#b7d7ce]/80" />
        )}
      </div>

      <p aria-live="polite" className="mt-3 min-h-10 text-xs leading-5 text-white/70">
        {message}
      </p>

      <div className="mt-3 grid gap-2">
        {cameraState !== "ready" ? (
          <button className="primary-button" disabled={cameraState === "loading"} onClick={startCamera} type="button">
            {cameraState === "loading" ? "Preparando..." : "Ativar câmera"}
          </button>
        ) : autoRecognize ? (
          <div aria-live="polite" className="rounded-md border border-[#7ee2c4]/40 bg-[#7ee2c4]/10 px-4 py-3 text-center text-sm font-semibold text-[#b7d7ce]">
            {recognitionPaused ? "Aguardando a confirmação..." : "Posicione o rosto no centro. O reconhecimento é automático."}
          </div>
        ) : (
          <>
            <button className="primary-button face-recognize-button" disabled={processing} onClick={() => void recognizeFace(false)} type="button">
              {processing ? "Processando..." : "Reconhecer rosto"}
            </button>
            {employee && (
              <button className="secondary-button" disabled={processing} onClick={registerFace} type="button">
                Capturar rosto de {employee.name}
              </button>
            )}
          </>
        )}
      </div>
    </div>
  );
}
