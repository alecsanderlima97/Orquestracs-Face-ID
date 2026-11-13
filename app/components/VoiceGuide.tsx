"use client";

import { useCallback, useEffect, useRef, useState } from "react";

// Guia por voz: narra a ajuda de cada tela com a voz feminina em pt-BR do proprio
// navegador (Web Speech API). Nao envia dados para servicos externos e nao usa creditos.

const SCRIPTS: Record<string, { title: string; text: string }> = {
  Painel: {
    title: "Painel",
    text: "Este é o Painel, a visão geral do seu dia. Aqui você acompanha quantos colaboradores já bateram o ponto, as horas previstas, as horas trabalhadas e o saldo do banco de horas. Para registrar um ponto, use o botão Nova batida. Para tirar um relatório, use Exportar relatório.",
  },
  Empresa: {
    title: "Empresa",
    text: "Esta é a tela da Empresa. Comece cadastrando a razão social, o CNPJ, o responsável e um contato. Depois, cadastre as escalas de trabalho, que servem de base para calcular a jornada de cada colaborador. Aqui também é possível convidar outras pessoas como proprietário, administrador ou leitor.",
  },
  Colaboradores: {
    title: "Colaboradores",
    text: "Aqui ficam os colaboradores. Para cadastrar, preencha nome, CPF, data de admissão, celular, cargo e departamento, e defina um PIN. Escolha se a pessoa segue a escala coletiva da empresa ou uma jornada individual. Por último, cadastre o Face ID: tire a foto com boa iluminação e registre o consentimento do colaborador.",
  },
  "Sala de ponto": {
    title: "Sala de ponto",
    text: "A Sala de ponto é a tela que fica aberta no tablet. Deixe o aparelho na altura do rosto e sem luz forte atrás da pessoa. O colaborador só precisa olhar para a câmera: o sistema reconhece o rosto e registra a batida. Se o reconhecimento falhar, ele pode usar o PIN com foto como alternativa.",
  },
  Batidas: {
    title: "Sala de ponto",
    text: "Nesta tela o tablet fica com a câmera ativa. O colaborador se posiciona na frente da câmera e, ao ser identificado, o sistema registra a batida com a evidência. Se o rosto não for reconhecido, use o PIN com foto.",
  },
  "Ponto externo": {
    title: "Ponto externo",
    text: "No Ponto externo, o colaborador registra a batida pelo próprio celular quando está fora da empresa. Primeiro, o administrador autoriza essa opção no cadastro dele. Na hora de bater o ponto, o colaborador informa o PIN e faz o reconhecimento facial. O sistema guarda o horário, a foto, a localização e o motivo como evidência.",
  },
  "Banco de horas": {
    title: "Banco de horas",
    text: "Este é o Banco de horas. Aqui você confere o saldo positivo ou negativo de cada colaborador, com horas extras, faltas, abonos e ocorrências. Analise com calma e só feche o período depois de conferir tudo.",
  },
  "Fechamento mensal": {
    title: "Fechamento mensal",
    text: "No Fechamento mensal, escolha o mês, o ano e o responsável pela conferência. Revise faltas, atrasos, banco de horas e ajustes. Depois, gere a folha para o contador e a ficha individual, para o colaborador tomar ciência.",
  },
  Relatorios: {
    title: "Relatórios",
    text: "Em Relatórios, você gera documentos em PDF. Pode tirar um relatório geral, com todos os colaboradores, ou um relatório individual, escolhendo a pessoa e o período. O modelo de jornada detalhada é ideal para conferência e assinatura.",
  },
  "LGPD e auditoria": {
    title: "LGPD e auditoria",
    text: "Esta é a área de LGPD e auditoria. Colete o consentimento do colaborador antes de cadastrar a biometria e mantenha sempre a alternativa do PIN com foto. A batida original nunca é apagada: qualquer correção vira um ajuste registrado, com responsável e motivo.",
  },
  Configuracoes: {
    title: "Configurações",
    text: "Em Configurações, você define os métodos de identificação do ponto, como Face ID e PIN com foto. Os leitores de digital aparecem apenas como avaliação e ainda não estão ativos no sistema.",
  },
  Admin: {
    title: "Admin",
    text: "Esta é a área Admin, de controle interno da plataforma. Aqui você gerencia convites, usuários e permissões da empresa ativa, separando os perfis de proprietário, administrador e leitor.",
  },
};

const TOUR_INTRO =
  "Olá! Eu sou a assistente do Orquestra Face ID. Vamos fazer um tour rápido: eu vou passar por cada tela e explicar para que ela serve.";
const TOUR_OUTRO =
  "Pronto! Esse foi o tour pelo Orquestra Face ID. Sempre que precisar, é só tocar em Guia por voz para ouvir a explicação da tela em que você estiver.";

// A Sala de ponto liga a camera; no tour ela e apenas narrada, sem abrir a tela.
const TOUR_NARRATE_ONLY = new Set(["Sala de ponto"]);

const STORAGE_KEY = "orquestra-faceid-voice-guide-v1";

type GuidePrefs = { autoVoice: boolean; seen: string[] };

function readPrefs(): GuidePrefs {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return { autoVoice: true, seen: [] };
    const parsed = JSON.parse(raw) as Partial<GuidePrefs>;
    return {
      autoVoice: parsed.autoVoice !== false,
      seen: Array.isArray(parsed.seen) ? parsed.seen.filter((item) => typeof item === "string") : [],
    };
  } catch {
    return { autoVoice: true, seen: [] };
  }
}

function writePrefs(prefs: GuidePrefs) {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(prefs));
  } catch {
    // Armazenamento indisponivel: o guia continua funcionando sem lembrar preferencias.
  }
}

const FEMALE_HINT = /francisca|luciana|maria|thalita|vit[oó]ria|helo[ií]sa|leila|camila|fernanda|female|feminin|google portugu[eê]s do brasil/i;
const MALE_HINT = /daniel|ant[oô]nio|felipe|ricardo|male\b|masculin/i;

function pickVoice(voices: SpeechSynthesisVoice[]) {
  const ptBr = voices.filter((voice) => voice.lang?.toLowerCase().replace("_", "-") === "pt-br");
  const pt = ptBr.length ? ptBr : voices.filter((voice) => voice.lang?.toLowerCase().startsWith("pt"));
  return (
    pt.find((voice) => FEMALE_HINT.test(voice.name) && !MALE_HINT.test(voice.name))
    || pt.find((voice) => !MALE_HINT.test(voice.name))
    || pt[0]
    || null
  );
}

function splitSentences(text: string) {
  // Frases curtas evitam o corte de falas longas que ocorre em alguns navegadores.
  return text.match(/[^.!?:]+[.!?:]?/g)?.map((part) => part.trim()).filter(Boolean) || [text];
}

function speechAvailable() {
  return typeof window !== "undefined" && "speechSynthesis" in window;
}

export function VoiceGuide({
  active,
  hidden,
  onNavigate,
  sections,
}: {
  active: string;
  hidden: boolean;
  onNavigate: (section: string) => void;
  sections: string[];
}) {
  const [supported] = useState(speechAvailable);
  const [autoVoice, setAutoVoice] = useState(() => (speechAvailable() ? readPrefs().autoVoice : true));
  const [openFor, setOpenFor] = useState<string | null>(null);
  const [speaking, setSpeaking] = useState(false);
  const [tour, setTour] = useState<{ index: number; total: number } | null>(null);
  const [tourCaption, setTourCaption] = useState<{ section: string; title: string; text: string } | null>(null);
  const runRef = useRef(0);
  const tourRef = useRef<string[]>([]);
  const activeRef = useRef(active);
  const stepRef = useRef<(index: number) => void>(() => {});

  const touring = tour !== null;

  useEffect(() => {
    activeRef.current = active;
  }, [active]);

  useEffect(() => () => {
    if (speechAvailable()) window.speechSynthesis.cancel();
  }, []);

  const stop = useCallback(() => {
    runRef.current += 1;
    if (speechAvailable()) window.speechSynthesis.cancel();
    setSpeaking(false);
  }, []);

  const speak = useCallback((text: string, onDone?: () => void) => {
    if (!speechAvailable()) {
      onDone?.();
      return;
    }
    const synth = window.speechSynthesis;
    synth.cancel();
    const run = ++runRef.current;
    const voice = pickVoice(synth.getVoices());
    const parts = splitSentences(text);
    setSpeaking(true);
    parts.forEach((part, index) => {
      const utterance = new SpeechSynthesisUtterance(part);
      utterance.lang = "pt-BR";
      if (voice) utterance.voice = voice;
      utterance.rate = 1;
      utterance.pitch = 1.05;
      if (index === parts.length - 1) {
        const finish = () => {
          if (run !== runRef.current) return;
          setSpeaking(false);
          onDone?.();
        };
        utterance.onend = finish;
        utterance.onerror = finish;
      }
      synth.speak(utterance);
    });
  }, []);

  // Ao trocar de tela fora do tour: interrompe a fala anterior e, na primeira visita,
  // abre a ajuda da tela e fala sozinha quando o navegador permite.
  useEffect(() => {
    if (touring) return;
    const timer = window.setTimeout(() => {
      stop();
      if (hidden) return;
      const script = SCRIPTS[active];
      if (!script || !speechAvailable()) return;
      const prefs = readPrefs();
      if (prefs.seen.includes(active)) return;
      writePrefs({ ...prefs, seen: [...prefs.seen, active] });
      setOpenFor(active);
      const activation = (navigator as Navigator & { userActivation?: { hasBeenActive: boolean } }).userActivation;
      if (prefs.autoVoice && activation?.hasBeenActive) speak(script.text);
    }, 350);
    return () => window.clearTimeout(timer);
  }, [active, hidden, speak, stop, touring]);

  const finishTour = useCallback(() => {
    tourRef.current = [];
    setTour(null);
    setTourCaption({ section: activeRef.current, title: "Fim do tour", text: TOUR_OUTRO });
    speak(TOUR_OUTRO);
  }, [speak]);

  const runTourStep = useCallback((index: number) => {
    const steps = tourRef.current;
    if (!steps.length) return;
    if (index >= steps.length) {
      finishTour();
      return;
    }
    const section = steps[index];
    const script = SCRIPTS[section];
    const shown = TOUR_NARRATE_ONLY.has(section) ? activeRef.current : section;
    if (shown !== activeRef.current) onNavigate(section);
    setTour({ index, total: steps.length });
    setTourCaption({ section: shown, ...script });
    setOpenFor(shown);
    speak(script.text, () => window.setTimeout(() => stepRef.current(index + 1), 700));
  }, [finishTour, onNavigate, speak]);

  useEffect(() => {
    stepRef.current = runTourStep;
  }, [runTourStep]);

  const startTour = () => {
    tourRef.current = sections.filter((section) => SCRIPTS[section]);
    setTour({ index: -1, total: tourRef.current.length });
    setTourCaption({ section: active, title: "Tour do sistema", text: TOUR_INTRO });
    setOpenFor(active);
    speak(TOUR_INTRO, () => window.setTimeout(() => stepRef.current(0), 500));
  };

  const endTour = () => {
    tourRef.current = [];
    setTour(null);
    setTourCaption(null);
    stop();
  };

  const toggleAutoVoice = () => {
    const next = !autoVoice;
    setAutoVoice(next);
    writePrefs({ ...readPrefs(), autoVoice: next });
    if (!next) stop();
  };

  const caption = tourCaption && tourCaption.section === active ? tourCaption : null;
  const current = caption || SCRIPTS[active] || null;
  const open = openFor === active || touring;
  if (!current || (hidden && !touring)) return null;

  return (
    <>
      {!open && (
        <button
          aria-label="Abrir guia por voz desta tela"
          className="voice-guide-launcher"
          onClick={() => {
            setTourCaption(null);
            setOpenFor(active);
          }}
          type="button"
        >
          Guia por voz
        </button>
      )}

      {open && (
        <aside aria-label="Guia por voz" aria-live="polite" className="voice-guide">
          <header className="voice-guide-head">
            <span aria-hidden="true" className={`voice-guide-avatar${speaking ? " is-speaking" : ""}`}>
              <i /><i /><i />
            </span>
            <div>
              <small>
                {tour
                  ? tour.index >= 0 ? `Tour guiado · ${tour.index + 1} de ${tour.total}` : "Tour guiado"
                  : "Assistente Face ID"}
              </small>
              <strong>{current.title}</strong>
            </div>
            <button
              aria-label="Fechar guia por voz"
              className="voice-guide-close"
              onClick={() => {
                if (touring) endTour();
                else stop();
                setTourCaption(null);
                setOpenFor(null);
              }}
              type="button"
            >
              ×
            </button>
          </header>

          <p className="voice-guide-text">{current.text}</p>

          {!supported && (
            <p className="voice-guide-note">Este navegador não tem leitura em voz. O texto acima mostra a explicação.</p>
          )}

          {supported && (
            <div className="voice-guide-actions">
              {speaking ? (
                <button className="voice-guide-btn" onClick={touring ? endTour : stop} type="button">
                  {touring ? "Parar tour" : "Parar"}
                </button>
              ) : (
                <button className="voice-guide-btn voice-guide-btn-primary" onClick={() => speak(current.text)} type="button">
                  Ouvir
                </button>
              )}
              {!touring && (
                <button className="voice-guide-btn" onClick={startTour} type="button">
                  Tour do sistema
                </button>
              )}
            </div>
          )}

          {supported && !touring && (
            <label className="voice-guide-toggle">
              <input checked={autoVoice} onChange={toggleAutoVoice} type="checkbox" />
              Falar sozinha ao abrir uma tela nova
            </label>
          )}
        </aside>
      )}
    </>
  );
}
