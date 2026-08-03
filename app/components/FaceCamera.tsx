"use client";

import { useEffect, useRef, useState } from "react";

const FACE_PROFILES_KEY = "orquestracs-face-id-local-profiles";
const MATCH_THRESHOLD = 0.5;
const MAX_CAPTURES_PER_EMPLOYEE = 5;

type FaceApiModule = typeof import("@vladmandic/face-api");

export type RecognizedFace = {
  employeeId: string;
  name: string;
  punchMode?: "automatic" | "manual";
  schedule?: {
    breakEnd: string;
    breakStart: string;
    end: string;
    start: string;
    toleranceMinutes: number;
  };
};

type StoredFaceProfile = RecognizedFace & {
  descriptors: number[][];
  updatedAt: string;
};

type FaceCameraProps = {
  compact?: boolean;
  employee?: RecognizedFace;
  onProfileUpdated?: (captureCount: number, photoBlob?: Blob) => void;
  onRecognized?: (employee: RecognizedFace, photoBlob?: Blob) => void;
  onStatus?: (message: string) => void;
};

function getProfiles() {
  try {
    return JSON.parse(window.localStorage.getItem(FACE_PROFILES_KEY) || "[]") as StoredFaceProfile[];
  } catch {
    return [];
  }
}

export function FaceCamera({
  compact = false,
  employee,
  onProfileUpdated,
  onRecognized,
  onStatus,
}: FaceCameraProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const faceApiRef = useRef<FaceApiModule | null>(null);
  const [cameraState, setCameraState] = useState<"idle" | "loading" | "ready" | "error">("idle");
  const [processing, setProcessing] = useState(false);
  const [message, setMessage] = useState("Ative a câmera para começar.");

  useEffect(() => {
    return () => {
      streamRef.current?.getTracks().forEach((track) => track.stop());
    };
  }, []);

  function updateMessage(value: string) {
    setMessage(value);
    onStatus?.(value);
  }

  async function loadFaceApi() {
    if (faceApiRef.current) return faceApiRef.current;

    const faceApi = await import("@vladmandic/face-api");
    await Promise.all([
      faceApi.nets.tinyFaceDetector.loadFromUri("/models/face-api"),
      faceApi.nets.faceLandmark68Net.loadFromUri("/models/face-api"),
      faceApi.nets.faceRecognitionNet.loadFromUri("/models/face-api"),
    ]);
    faceApiRef.current = faceApi;
    return faceApi;
  }

  async function startCamera() {
    if (!navigator.mediaDevices?.getUserMedia) {
      setCameraState("error");
      updateMessage("Este navegador não oferece acesso compatível à câmera.");
      return;
    }

    setCameraState("loading");
    updateMessage("Carregando câmera e reconhecimento...");

    try {
      const [, stream] = await Promise.all([
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
      updateMessage("Câmera ativa. Mantenha apenas um rosto centralizado.");
    } catch (error) {
      console.error(error);
      setCameraState("error");
      updateMessage("Não foi possível abrir a câmera. Verifique a permissão e use HTTPS.");
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

  async function registerFace() {
    if (!employee) {
      updateMessage("Selecione ou cadastre um colaborador antes da captura facial.");
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

      const profiles = getProfiles();
      const existingIndex = profiles.findIndex((profile) => profile.employeeId === employee.employeeId);
      const existing = existingIndex >= 0 ? profiles[existingIndex] : null;
      const descriptors = [
        ...(existing?.descriptors || []),
        Array.from(detection.descriptor),
      ].slice(-MAX_CAPTURES_PER_EMPLOYEE);
      const profile: StoredFaceProfile = {
        ...employee,
        descriptors,
        updatedAt: new Date().toISOString(),
      };

      if (existingIndex >= 0) {
        profiles[existingIndex] = profile;
      } else {
        profiles.push(profile);
      }

      window.localStorage.setItem(FACE_PROFILES_KEY, JSON.stringify(profiles));
      onProfileUpdated?.(descriptors.length, await captureFrame());
      updateMessage(
        `${employee.name}: captura ${descriptors.length}/${MAX_CAPTURES_PER_EMPLOYEE} salva neste aparelho.`,
      );
    } finally {
      setProcessing(false);
    }
  }

  async function recognizeFace() {
    setProcessing(true);
    updateMessage("Comparando o rosto...");

    try {
      const profiles = getProfiles();
      if (!profiles.length) {
        updateMessage("Nenhum colaborador possui Face ID cadastrado neste aparelho.");
        return;
      }

      const detection = await readDescriptor();
      if (!detection) {
        updateMessage("Nenhum rosto nítido foi encontrado. Posicione-se no centro.");
        return;
      }

      const faceApi = faceApiRef.current;
      if (!faceApi) return;

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
        updateMessage("Rosto não reconhecido. Use o PIN ou tente novamente.");
      }
    } catch (error) {
      console.error(error);
      updateMessage("O cadastro facial local está inválido. Cadastre o rosto novamente.");
    } finally {
      setProcessing(false);
    }
  }

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
        ) : (
          <>
            <button className="primary-button face-recognize-button" disabled={processing} onClick={recognizeFace} type="button">
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
