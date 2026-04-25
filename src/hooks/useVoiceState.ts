import { useCallback, useEffect, useRef, useState } from "react";

type VoiceOptions = {
  voiceEnabled: boolean;
  outputEnabled: boolean;
  onTranscriptFinal?: (transcript: string) => Promise<void> | void;
};

export function useVoiceState(options: VoiceOptions) {
  const { voiceEnabled, outputEnabled, onTranscriptFinal } = options;
  const [isListening, setIsListening] = useState(false);
  const [transcript, setTranscript] = useState("");
  const [interimTranscript, setInterimTranscript] = useState("");
  const [voiceError, setVoiceError] = useState<string | null>(null);
  const [waveform, setWaveform] = useState<number[]>([0.18, 0.22, 0.16, 0.2, 0.14, 0.26]);
  const [recordings, setRecordings] = useState<Array<{ id: string; url: string; createdAt: string }>>([]);
  const recognitionRef = useRef<any>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const animationRef = useRef<number | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const transcriptRef = useRef("");
  const interimTranscriptRef = useRef("");
  const transcriptCallbackRef = useRef<VoiceOptions["onTranscriptFinal"]>(onTranscriptFinal);

  useEffect(() => {
    transcriptRef.current = transcript;
  }, [transcript]);

  useEffect(() => {
    interimTranscriptRef.current = interimTranscript;
  }, [interimTranscript]);

  useEffect(() => {
    transcriptCallbackRef.current = onTranscriptFinal;
  }, [onTranscriptFinal]);

  const stopWaveform = useCallback(() => {
    if (animationRef.current) {
      cancelAnimationFrame(animationRef.current);
      animationRef.current = null;
    }
    setWaveform([0.18, 0.22, 0.16, 0.2, 0.14, 0.26]);
  }, []);

  const animateWaveform = useCallback(() => {
    const analyser = analyserRef.current;
    if (!analyser) {
      return;
    }

    const data = new Uint8Array(analyser.frequencyBinCount);
    const step = () => {
      analyser.getByteFrequencyData(data);
      const bandSize = Math.max(1, Math.floor(data.length / 6));
      const next = Array.from({ length: 6 }).map((_, index) => {
        const start = index * bandSize;
        const slice = data.slice(start, start + bandSize);
        const average = slice.reduce((sum, value) => sum + value, 0) / Math.max(1, slice.length);
        return Math.max(0.12, Math.min(0.95, average / 180));
      });
      setWaveform(next);
      animationRef.current = requestAnimationFrame(step);
    };
    animationRef.current = requestAnimationFrame(step);
  }, []);

  const cleanupAudio = useCallback(() => {
    stopWaveform();
    if (mediaRecorderRef.current && mediaRecorderRef.current.state !== "inactive") {
      mediaRecorderRef.current.stop();
    }
    mediaStreamRef.current?.getTracks().forEach((track) => track.stop());
    mediaStreamRef.current = null;
    audioContextRef.current?.close().catch(() => undefined);
    audioContextRef.current = null;
    analyserRef.current = null;
    mediaRecorderRef.current = null;
  }, [stopWaveform]);

  const speak = useCallback(
    (text: string) => {
      if (!voiceEnabled || !outputEnabled || !("speechSynthesis" in window)) {
        return;
      }
      window.speechSynthesis.cancel();
      const utterance = new SpeechSynthesisUtterance(text);
      utterance.rate = 0.95;
      utterance.pitch = 0.95;
      utterance.voice =
        window.speechSynthesis.getVoices().find((voice) => voice.lang.includes("en")) || null;
      window.speechSynthesis.speak(utterance);
    },
    [outputEnabled, voiceEnabled],
  );

  const stopListening = useCallback(() => {
    recognitionRef.current?.stop();
    cleanupAudio();
    setIsListening(false);
  }, [cleanupAudio]);

  const startListening = useCallback(async () => {
    if (!voiceEnabled) {
      setVoiceError("Voice input is disabled in settings.");
      return;
    }

    try {
      setVoiceError(null);
      setTranscript("");
      setInterimTranscript("");
      const mediaStream = await navigator.mediaDevices.getUserMedia({ audio: true });
      mediaStreamRef.current = mediaStream;
      const MediaRecorderCtor = window.MediaRecorder;
      if (MediaRecorderCtor) {
        const mediaRecorder = new MediaRecorderCtor(mediaStream);
        mediaRecorderRef.current = mediaRecorder;
        chunksRef.current = [];
        mediaRecorder.ondataavailable = (event) => {
          if (event.data.size > 0) {
            chunksRef.current.push(event.data);
          }
        };
        mediaRecorder.onstop = () => {
          if (chunksRef.current.length === 0) {
            return;
          }
          const blob = new Blob(chunksRef.current, { type: "audio/webm" });
          const url = URL.createObjectURL(blob);
          setRecordings((current) => [
            { id: crypto.randomUUID(), url, createdAt: new Date().toISOString() },
            ...current,
          ]);
          chunksRef.current = [];
        };
        mediaRecorder.start();
      }

      const AudioContextCtor = window.AudioContext || (window as any).webkitAudioContext;
      if (AudioContextCtor) {
        const context = new AudioContextCtor();
        audioContextRef.current = context;
        const source = context.createMediaStreamSource(mediaStream);
        const analyser = context.createAnalyser();
        analyser.fftSize = 64;
        source.connect(analyser);
        analyserRef.current = analyser;
        animateWaveform();
      }

      recognitionRef.current?.start();
      setIsListening(true);
    } catch (error) {
      cleanupAudio();
      setVoiceError(error instanceof Error ? error.message : "Microphone access was denied.");
    }
  }, [animateWaveform, cleanupAudio, voiceEnabled]);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }

    const Recognition =
      (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition || (window as any).speechRecognition;

    if (!Recognition) {
      setVoiceError("Speech recognition is not supported in this browser.");
      return;
    }

    const recognition = new Recognition();
    recognition.continuous = true;
    recognition.interimResults = true;

    recognition.onresult = (event: any) => {
      let interim = "";
      let finalTranscript = "";

      for (let index = event.resultIndex; index < event.results.length; index += 1) {
        const result = event.results[index];
        const content = result[0]?.transcript || "";
        if (result.isFinal) {
          finalTranscript += content;
        } else {
          interim += content;
        }
      }

      if (finalTranscript) {
        setTranscript((current) => `${current} ${finalTranscript}`.trim());
      }
      setInterimTranscript(interim);
    };

    recognition.onerror = (event: any) => {
      setVoiceError(event.error || "Voice recognition failed.");
    };

    recognition.onend = async () => {
      setIsListening(false);
      cleanupAudio();
      const finalTranscript = `${transcriptRef.current} ${interimTranscriptRef.current}`.trim();
      if (finalTranscript) {
        setTranscript(finalTranscript);
        setInterimTranscript("");
        await transcriptCallbackRef.current?.(finalTranscript);
      }
    };

    recognitionRef.current = recognition;

    return () => {
      recognition.stop();
      cleanupAudio();
      window.speechSynthesis?.cancel();
    };
  }, [cleanupAudio]);

  return {
    isListening,
    transcript,
    interimTranscript,
    voiceError,
    waveform,
    recordings,
    startListening,
    stopListening,
    setTranscript,
    speak,
  };
}
