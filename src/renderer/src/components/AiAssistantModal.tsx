import React, { useState, useEffect, useRef } from 'react';
import {
  Sparkles,
  X,
  Send,
  Settings as SettingsIcon,
  HardDrive,
  Eye,
  Check,
  AlertCircle,
  Key,
  Layers,
  ArrowRight,
  MessageSquare,
  Trash2
} from 'lucide-react';
import { Photo, Person } from '../../types';
import {
  aiSearchService,
  AiSearchConfig,
  AiSearchResult,
  AiPhotoFilter,
  AiProvider
} from '../services/aiSearchService';
import { getLocalPhotoUrl } from '../services/libraryStore';

interface AiChatMessage {
  id: string;
  sender: 'user' | 'assistant';
  text: string;
  result?: AiSearchResult;
  timestamp: string;
}

interface AiAssistantModalProps {
  photos: Photo[];
  people: Person[];
  isOpen: boolean;
  onClose: () => void;
  onApplyFilter: (filter: AiPhotoFilter, matchedPhotos: Photo[]) => void;
}

const SAMPLE_PROMPTS = [
  "Photo of rajshree's childhood",
  "Photo of sachin and monika",
  "Photo of sachin, monika and rajshree",
  "Photos of sachin in andaman",
  "Photo of monika alone",
];

export const AiAssistantModal: React.FC<AiAssistantModalProps> = ({
  photos,
  people,
  isOpen,
  onClose,
  onApplyFilter,
}) => {
  const [messages, setMessages] = useState<AiChatMessage[]>([
    {
      id: 'welcome_1',
      sender: 'assistant',
      text: "Hi! I'm your AI Photo Assistant. You can ask me to find specific photos across people, places, dates, and memories.",
      timestamp: 'Just now',
    },
  ]);
  const [inputText, setInputText] = useState('');
  const [isProcessing, setIsProcessing] = useState(false);
  const [showConfig, setShowConfig] = useState(false);
  const [config, setConfig] = useState<AiSearchConfig>(aiSearchService.getConfig());
  const [configSaveFeedback, setConfigSaveFeedback] = useState<string | null>(null);

  const messagesEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (isOpen) {
      setConfig(aiSearchService.loadConfig());
    }
  }, [isOpen]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, isProcessing]);

  if (!isOpen) return null;

  const handleSendMessage = async (queryText?: string) => {
    const text = (queryText || inputText).trim();
    if (!text || isProcessing) return;

    setInputText('');

    const userMsg: AiChatMessage = {
      id: 'msg_' + Date.now(),
      sender: 'user',
      text,
      timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
    };

    setMessages((prev) => [...prev, userMsg]);
    setIsProcessing(true);

    try {
      const searchResult = await aiSearchService.search(text, photos, people);

      const assistantMsg: AiChatMessage = {
        id: 'msg_' + (Date.now() + 1),
        sender: 'assistant',
        text: searchResult.answer,
        result: searchResult,
        timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
      };

      setMessages((prev) => [...prev, assistantMsg]);
    } catch (err: any) {
      const errorMsg: AiChatMessage = {
        id: 'msg_' + (Date.now() + 1),
        sender: 'assistant',
        text: `Sorry, I encountered an issue searching your photos: ${err.message || 'Unknown error'}`,
        timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
      };
      setMessages((prev) => [...prev, errorMsg]);
    } finally {
      setIsProcessing(false);
    }
  };

  const handleSaveConfig = (e: React.FormEvent) => {
    e.preventDefault();
    aiSearchService.saveConfig(config);
    setConfigSaveFeedback('✓ AI Configuration saved successfully!');
    setTimeout(() => {
      setConfigSaveFeedback(null);
      setShowConfig(false);
    }, 1500);
  };

  const handleClearHistory = () => {
    setMessages([
      {
        id: 'welcome_' + Date.now(),
        sender: 'assistant',
        text: "Conversation cleared. How can I help you find photos today?",
        timestamp: 'Just now',
      },
    ]);
  };

  return (
    <div
      style={{
        position: 'fixed',
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        backgroundColor: 'rgba(3, 7, 18, 0.75)',
        backdropFilter: 'blur(10px)',
        zIndex: 4000,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '24px',
      }}
      onClick={onClose}
    >
      <div
        style={{
          width: '100%',
          maxWidth: '820px',
          height: '85vh',
          maxHeight: '740px',
          backgroundColor: 'var(--bg-surface)',
          border: '1px solid var(--border-subtle)',
          borderRadius: 'var(--radius-xl)',
          boxShadow: '0 25px 50px -12px rgba(0, 0, 0, 0.7)',
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden',
        }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Chatbot Header */}
        <div
          style={{
            padding: '16px 24px',
            borderBottom: '1px solid var(--border-subtle)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            backgroundColor: 'var(--bg-surface-elevated)',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
            <div
              style={{
                width: '38px',
                height: '38px',
                borderRadius: 'var(--radius-md)',
                background: 'linear-gradient(135deg, #6366f1 0%, #a855f7 50%, #ec4899 100%)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                boxShadow: '0 0 16px rgba(168, 85, 247, 0.4)',
              }}
            >
              <Sparkles size={20} color="white" />
            </div>
            <div>
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                <h3 style={{ margin: 0, fontSize: '1.15rem', fontWeight: 700, color: 'var(--text-primary)' }}>
                  AI Photo Assistant
                </h3>
                <span
                  style={{
                    fontSize: '11px',
                    padding: '2px 8px',
                    borderRadius: 'var(--radius-full)',
                    backgroundColor:
                      config.provider === 'gemini'
                        ? 'rgba(59, 130, 246, 0.2)'
                        : config.provider === 'openai'
                        ? 'rgba(16, 185, 129, 0.2)'
                        : 'rgba(148, 163, 184, 0.2)',
                    color:
                      config.provider === 'gemini'
                        ? 'var(--accent-primary)'
                        : config.provider === 'openai'
                        ? 'var(--accent-emerald)'
                        : 'var(--text-secondary)',
                    fontWeight: 600,
                  }}
                >
                  {config.provider === 'gemini'
                    ? 'Google Gemini'
                    : config.provider === 'openai'
                    ? 'OpenAI'
                    : 'Smart NLP (Offline)'}
                </span>
              </div>
              <p style={{ margin: 0, fontSize: '0.75rem', color: 'var(--text-muted)' }}>
                Ask natural questions to filter photos, identify people combinations, and explore places
              </p>
            </div>
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <button
              className="btn btn-ghost btn-icon"
              onClick={() => setShowConfig(!showConfig)}
              style={{
                width: '36px',
                height: '36px',
                color: showConfig ? 'var(--accent-primary)' : 'var(--text-muted)',
              }}
              title="Configure LLM API Keys (Gemini, OpenAI)"
            >
              <Key size={18} />
            </button>
            <button
              className="btn btn-ghost btn-icon"
              onClick={handleClearHistory}
              style={{ width: '36px', height: '36px', color: 'var(--text-muted)' }}
              title="Clear chat history"
            >
              <Trash2 size={18} />
            </button>
            <button
              className="btn btn-ghost btn-icon"
              onClick={onClose}
              style={{ width: '36px', height: '36px' }}
            >
              <X size={20} />
            </button>
          </div>
        </div>

        {/* Inline API Key Configuration Drawer */}
        {showConfig && (
          <div
            style={{
              padding: '20px 24px',
              backgroundColor: 'rgba(15, 23, 42, 0.95)',
              borderBottom: '1px solid var(--border-subtle)',
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '16px' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                <Key size={18} color="var(--accent-primary)" />
                <h4 style={{ margin: 0, fontSize: '0.95rem', fontWeight: 700 }}>
                  Configure AI / LLM Provider
                </h4>
              </div>
              <span style={{ fontSize: '0.78rem', color: 'var(--text-muted)' }}>
                Keys are stored locally on your device
              </span>
            </div>

            <form onSubmit={handleSaveConfig}>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: '16px' }}>
                <div>
                  <label style={{ display: 'block', fontSize: '0.8rem', fontWeight: 600, marginBottom: '6px' }}>
                    Active Provider
                  </label>
                  <select
                    className="input"
                    value={config.provider}
                    onChange={(e) => setConfig({ ...config, provider: e.target.value as AiProvider })}
                    style={{ height: '38px', width: '100%' }}
                  >
                    <option value="local">Smart NLP Engine (Offline, No API Key Required)</option>
                    <option value="gemini">Google Gemini API (Recommended)</option>
                    <option value="openai">OpenAI ChatGPT API</option>
                  </select>
                </div>

                <div>
                  <label style={{ display: 'block', fontSize: '0.8rem', fontWeight: 600, marginBottom: '6px' }}>
                    Google Gemini API Key
                  </label>
                  <input
                    type="password"
                    className="input"
                    placeholder="AIzaSy..."
                    value={config.geminiApiKey}
                    onChange={(e) => setConfig({ ...config, geminiApiKey: e.target.value })}
                    style={{ height: '38px', width: '100%' }}
                  />
                </div>

                <div>
                  <label style={{ display: 'block', fontSize: '0.8rem', fontWeight: 600, marginBottom: '6px' }}>
                    OpenAI API Key
                  </label>
                  <input
                    type="password"
                    className="input"
                    placeholder="sk-proj-..."
                    value={config.openaiApiKey}
                    onChange={(e) => setConfig({ ...config, openaiApiKey: e.target.value })}
                    style={{ height: '38px', width: '100%' }}
                  />
                </div>
              </div>

              {configSaveFeedback && (
                <div style={{ marginTop: '12px', fontSize: '0.82rem', color: 'var(--accent-emerald)', fontWeight: 600 }}>
                  {configSaveFeedback}
                </div>
              )}

              <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '10px', marginTop: '16px' }}>
                <button
                  type="button"
                  className="btn btn-ghost"
                  onClick={() => setShowConfig(false)}
                  style={{ height: '36px', padding: '0 16px' }}
                >
                  Cancel
                </button>
                <button type="submit" className="btn btn-primary" style={{ height: '36px', padding: '0 20px' }}>
                  Save Configuration
                </button>
              </div>
            </form>
          </div>
        )}

        {/* Quick Sample Prompts Bar */}
        <div
          style={{
            padding: '10px 24px',
            backgroundColor: 'rgba(255, 255, 255, 0.02)',
            borderBottom: '1px solid var(--border-subtle)',
            display: 'flex',
            alignItems: 'center',
            gap: '8px',
            overflowX: 'auto',
            whiteSpace: 'nowrap',
          }}
        >
          <span style={{ fontSize: '0.75rem', fontWeight: 600, color: 'var(--text-muted)' }}>
            Try asking:
          </span>
          {SAMPLE_PROMPTS.map((sample) => (
            <button
              key={sample}
              className="btn btn-ghost"
              onClick={() => handleSendMessage(sample)}
              style={{
                fontSize: '0.78rem',
                padding: '4px 10px',
                borderRadius: 'var(--radius-full)',
                backgroundColor: 'var(--bg-surface-elevated)',
                border: '1px solid var(--border-subtle)',
                color: 'var(--text-primary)',
              }}
            >
              {sample}
            </button>
          ))}
        </div>

        {/* Messages List Area */}
        <div
          style={{
            flex: 1,
            overflowY: 'auto',
            padding: '20px 24px',
            display: 'flex',
            flexDirection: 'column',
            gap: '20px',
          }}
        >
          {messages.map((msg) => (
            <div
              key={msg.id}
              style={{
                display: 'flex',
                flexDirection: 'column',
                alignItems: msg.sender === 'user' ? 'flex-end' : 'flex-start',
              }}
            >
              <div
                style={{
                  maxWidth: '85%',
                  backgroundColor: msg.sender === 'user' ? 'var(--accent-primary)' : 'var(--bg-surface-elevated)',
                  color: msg.sender === 'user' ? '#ffffff' : 'var(--text-primary)',
                  borderRadius:
                    msg.sender === 'user'
                      ? 'var(--radius-lg) var(--radius-lg) 2px var(--radius-lg)'
                      : 'var(--radius-lg) var(--radius-lg) var(--radius-lg) 2px',
                  padding: '14px 18px',
                  boxShadow: 'var(--shadow-sm)',
                  border: msg.sender === 'user' ? 'none' : '1px solid var(--border-subtle)',
                }}
              >
                <div style={{ fontSize: '0.9rem', lineHeight: 1.5 }}>
                  {msg.text}
                </div>

                {/* If Assistant returned matched photos: show tags and preview carousel */}
                {msg.result && msg.result.matchedPhotos && (
                  <div style={{ marginTop: '14px' }}>
                    {/* Filter Summary Tags */}
                    {msg.result.summaryTags.length > 0 && (
                      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px', marginBottom: '12px' }}>
                        {msg.result.summaryTags.map((tag, idx) => (
                          <span
                            key={idx}
                            style={{
                              fontSize: '11px',
                              fontWeight: 600,
                              padding: '3px 8px',
                              borderRadius: 'var(--radius-full)',
                              backgroundColor: 'rgba(59, 130, 246, 0.15)',
                              color: 'var(--accent-cyan)',
                              border: '1px solid rgba(59, 130, 246, 0.3)',
                            }}
                          >
                            {tag}
                          </span>
                        ))}
                      </div>
                    )}

                    {/* Preview Carousel of Photos */}
                    {msg.result.matchedPhotos.length > 0 ? (
                      <div>
                        <div
                          style={{
                            display: 'flex',
                            gap: '8px',
                            overflowX: 'auto',
                            paddingBottom: '8px',
                            marginBottom: '12px',
                          }}
                        >
                          {msg.result.matchedPhotos.slice(0, 6).map((photo) => (
                            <div
                              key={photo.id}
                              style={{
                                width: '88px',
                                height: '88px',
                                flexShrink: 0,
                                borderRadius: 'var(--radius-md)',
                                overflow: 'hidden',
                                border: '1px solid var(--border-subtle)',
                                backgroundColor: '#05080f',
                              }}
                            >
                              <img
                                src={getLocalPhotoUrl(photo.thumbnailPath || photo.filePath, photo.originalRemotePath, false)}
                                alt={photo.fileName}
                                loading="lazy"
                                style={{
                                  width: '100%',
                                  height: '100%',
                                  objectFit: 'cover',
                                  imageOrientation: 'from-image',
                                }}
                              />
                            </div>
                          ))}
                        </div>

                        {/* View in Gallery Action Button */}
                        <button
                          className="btn btn-primary"
                          onClick={() => {
                            if (msg.result) {
                              onApplyFilter(msg.result.filter, msg.result.matchedPhotos);
                              onClose();
                            }
                          }}
                          style={{
                            width: '100%',
                            padding: '10px 16px',
                            fontSize: '0.85rem',
                            fontWeight: 600,
                            gap: '8px',
                            justifyContent: 'center',
                          }}
                        >
                          <Eye size={16} />
                          <span>
                            View {msg.result.matchedPhotos.length}{' '}
                            {msg.result.matchedPhotos.length === 1 ? 'Photo' : 'Photos'} in Gallery
                          </span>
                          <ArrowRight size={15} />
                        </button>
                      </div>
                    ) : (
                      <div style={{ fontSize: '0.82rem', color: 'var(--text-muted)', fontStyle: 'italic' }}>
                        No photos in the library matched these specific criteria.
                      </div>
                    )}
                  </div>
                )}
              </div>

              <span style={{ fontSize: '0.7rem', color: 'var(--text-muted)', marginTop: '4px', padding: '0 4px' }}>
                {msg.timestamp}
              </span>
            </div>
          ))}

          {isProcessing && (
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px', color: 'var(--text-muted)' }}>
              <Sparkles size={16} className="animate-spin" color="var(--accent-primary)" />
              <span style={{ fontSize: '0.85rem' }}>Searching photos and analyzing people...</span>
            </div>
          )}

          <div ref={messagesEndRef} />
        </div>

        {/* Input Bar */}
        <div
          style={{
            padding: '16px 24px',
            borderTop: '1px solid var(--border-subtle)',
            backgroundColor: 'var(--bg-surface-elevated)',
            display: 'flex',
            alignItems: 'center',
            gap: '12px',
          }}
        >
          <input
            type="text"
            className="input"
            placeholder="Ask AI to find photos... (e.g. 'Photo of sachin and monika', 'Photo of monika alone')"
            value={inputText}
            onChange={(e) => setInputText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                handleSendMessage();
              }
            }}
            disabled={isProcessing}
            style={{ height: '44px', flex: 1, fontSize: '0.9rem' }}
            autoFocus
          />

          <button
            className="btn btn-primary"
            onClick={() => handleSendMessage()}
            disabled={!inputText.trim() || isProcessing}
            style={{ width: '44px', height: '44px', borderRadius: 'var(--radius-md)', padding: 0, display: 'flex', alignItems: 'center', justifyContent: 'center' }}
            title="Send Query"
          >
            <Send size={18} />
          </button>
        </div>
      </div>
    </div>
  );
};
