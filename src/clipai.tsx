import {
  ActionPanel, Action, List, showToast, Toast, Clipboard, getPreferenceValues,
  openExtensionPreferences, Detail, useNavigation, Form, Icon, Color
} from "@raycast/api";
import { useState, useEffect, useCallback } from "react";
import { Preferences, ChatMessage, HotKey, EnhancedClipboardData } from "./types";
import { HotkeysSettingsView } from "./components/settings";
import { DEFAULT_CONFIG } from "./constants";
import { DEFAULT_HOTKEYS } from "./hotkeys";
import fs from "fs";


// Utility function to check if model supports vision
function isVisionModel(model: string): boolean {
  const visionModels = [
    'gpt-4o',
    'gpt-4o-mini',
    'gpt-4-turbo',
    'gpt-4-vision-preview',
    'gpt-4-turbo-2024-04-09'
  ];
  return visionModels.some(visionModel => model.toLowerCase().includes(visionModel.toLowerCase()));
}

// Enhanced OpenAI API call with vision support
async function callOpenAI(messages: ChatMessage[], preferences: Preferences): Promise<string> {
  try {
    const temperature = parseFloat(preferences.temperature) || DEFAULT_CONFIG.temperature;
    const maxTokens = parseInt(preferences.maxTokens) || DEFAULT_CONFIG.maxTokens;
    let model = preferences.model || DEFAULT_CONFIG.model;

    // Check if any message contains images
    const hasImages = messages.some(msg => 
      Array.isArray(msg.content) && 
      msg.content.some(content => content.type === "image_url")
    );

    // Auto-switch to vision model if images are present and current model doesn't support vision
    if (hasImages && !isVisionModel(model)) {
      model = "gpt-4o"; // Default vision model
      showToast({
        style: Toast.Style.Success,
        title: "Switched to Vision Model",
        message: `Using ${model} for image processing`,
      });
    }

    const response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${preferences.apiKey}`,
      },
      body: JSON.stringify({
        model: model,
        messages: messages,
        max_tokens: hasImages ? Math.min(maxTokens, 4096) : maxTokens, // Vision models have token limits
        temperature: temperature,
      }),
    });

    if (!response.ok) {
      let errorMessage = `HTTP ${response.status}: ${response.statusText}`;
      try {
        const errorData = await response.json();
        if (typeof errorData === 'object' && errorData !== null && 'error' in errorData && errorData.error && typeof errorData.error === 'object' && 'message' in errorData.error) {
          errorMessage = (errorData.error as { message: string }).message;
        }
      } catch {/* ignore */}
      throw new Error(errorMessage);
    }

    const data = await response.json() as { choices: { message: { content: string } }[] };
    if (!data.choices || !data.choices[0] || !data.choices[0].message) {
      throw new Error("Invalid response format from OpenAI API");
    }
    const content = data.choices[0].message.content;
    if (typeof content !== 'string') {
      throw new Error("OpenAI response content is not a string");
    }
    return content;
  } catch (error) {
    if (error instanceof Error) {
      throw error;
    }
    throw new Error("Failed to call OpenAI API");
  }
}

// Enhanced clipboard loading with image support
async function loadClipboardData(): Promise<EnhancedClipboardData> {
  try {
    // Try to read clipboard content
    const clipboardContent = await Clipboard.read();
    const text = clipboardContent.text?.trim();
    const images: ImageData[] = [];

    // Process images if present
    if (clipboardContent.file) {
      try {
        let filePath = clipboardContent.file;
        if (filePath.startsWith("file://")) {
          filePath = new URL(filePath).pathname;
          filePath = decodeURIComponent(filePath);
        }
        const fileBuffer = fs.readFileSync(filePath);
        const base64 = fileBuffer.toString("base64");
        const mimeType = "image/png";
        images.push({
          base64,
          mimeType,
        });
      } catch (error) {
        console.error("Error processing clipboard image:", error);
      }
    }

    // Determine clipboard type
    if (images.length > 0 && text) {
      return { type: "mixed", text, images };
    } else if (images.length > 0) {
      return { type: "image", images };
    } else if (text) {
      return { type: "text", text };
    } else {
      return { type: "empty" };
    }
  } catch (error) {
    console.error("Error reading clipboard:", error);
    return { type: "empty" };
  }
}

// Create chat message content from clipboard data
function createMessageContent(prompt: string, clipboardData: EnhancedClipboardData): ChatMessage["content"] {
  const content: any[] = [];

  // Add the prompt text
  if (prompt.trim()) {
    content.push({
      type: "text",
      text: prompt
    });
  }

  // Add clipboard text if present
  if (clipboardData.text) {
    const textToAdd = prompt.trim() ? `\n\n${clipboardData.text}` : clipboardData.text;
    if (content.length > 0) {
      content[0].text += textToAdd;
    } else {
      content.push({
        type: "text",
        text: textToAdd
      });
    }
  }

  // Add images if present
  if (clipboardData.images && clipboardData.images.length > 0) {
    clipboardData.images.forEach(image => {
      content.push({
        type: "image_url",
        image_url: {
          url: `data:${image.mimeType};base64,${image.base64}`,
          detail: "high"
        }
      });
    });
  }

  // Return appropriate format
  if (content.length === 1 && content[0].type === "text") {
    return content[0].text;
  }
  return content;
}

function ChatInputForm({ onSubmit }: {
  onSubmit: (input: string) => Promise<void>;
}) {
  const [isLoading, setIsLoading] = useState(false);
  const { pop } = useNavigation();

  const handleSubmit = async (values: { message: string }) => {
    if (!values.message.trim()) {
      showToast({
        style: Toast.Style.Failure,
        title: "Empty Message",
        message: "Please enter a message",
      });
      return;
    }

    setIsLoading(true);
    try {
      await onSubmit(values.message);
      pop();
    } catch (error) {
      showToast({
        style: Toast.Style.Failure,
        title: "Error",
        message: error instanceof Error ? error.message : "Failed to send message",
      });
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <Form
      isLoading={isLoading}
      actions={
        <ActionPanel>
          <Action.SubmitForm
            title="Send Message"
            icon={Icon.ArrowRight}
            onSubmit={handleSubmit}
          />
          <Action
            title="Cancel"
            icon={Icon.XMarkCircle}
            onAction={pop}
          />
        </ActionPanel>
      }
    >
      <Form.TextArea
        id="message"
        title="Your Message"
        placeholder="Type your message here..."
        enableMarkdown
        autoFocus
      />
    </Form>
  );
}

function ChatView({ initialMessages }: { initialMessages: ChatMessage[] }) {
  const [messages, setMessages] = useState<ChatMessage[]>(initialMessages);
  const [isLoading, setIsLoading] = useState(false);
  const [clipboardData, setClipboardData] = useState<EnhancedClipboardData>({ type: "empty" });
  const { pop, push } = useNavigation();
  const preferences = getPreferenceValues<Preferences>();

  // Load clipboard data when component mounts
  useEffect(() => {
    loadClipboardData().then(setClipboardData);
  }, []);

  const lastAssistantMessage = messages
    .slice()
    .reverse()
    .find((msg) => msg.role === "assistant")?.content;

  const lastAssistantText = typeof lastAssistantMessage === 'string'
    ? lastAssistantMessage
    : Array.isArray(lastAssistantMessage)
      ? lastAssistantMessage.find(c => c.type === "text")?.text || ""
      : "";

  const conversationMarkdown = messages
    .map((msg) => {
      const role = msg.role === "user" ? "🧑‍💻 You" : "🤖 Assistant";
      let content = "";

      if (typeof msg.content === 'string') {
        content = msg.content;
      } else if (Array.isArray(msg.content)) {
        const textParts = msg.content
          .filter(c => c.type === "text")
          .map(c => c.text)
          .join(" ");
        const imageCount = msg.content.filter(c => c.type === "image_url").length;
        content = imageCount > 0 ? `[${imageCount} Image${imageCount > 1 ? 's' : ''}] ${textParts}` : textParts;
      }

      return `## ${role}

${content}`;
    })
    .join("\n\n---\n\n");

  const sendNewMessage = useCallback(() => {
    const handleSubmit = async (input: string) => {
      const userContent = createMessageContent(input, clipboardData);
      const userMessage: ChatMessage = { role: "user", content: userContent };
      const newMessages = [...messages, userMessage];
      setMessages(newMessages);
      setIsLoading(true);

      try {
        const response = await callOpenAI(newMessages, preferences);
        const assistantMessage: ChatMessage = { role: "assistant", content: response };
        setMessages([...newMessages, assistantMessage]);

        showToast({
          style: Toast.Style.Success,
          title: "Response received",
        });
      } catch (error) {
        showToast({
          style: Toast.Style.Failure,
          title: "Error",
          message: error instanceof Error ? error.message : "Failed to get AI response",
        });
      } finally {
        setIsLoading(false);
      }
    };

    push(<ChatInputForm onSubmit={handleSubmit} />);
  }, [messages, preferences, push, clipboardData]);

  return (
    <Detail
      markdown={conversationMarkdown}
      isLoading={isLoading}
      actions={
        <ActionPanel>
          <ActionPanel.Section title="Chat Actions">
            <Action
              title="Send Message"
              icon={Icon.ArrowRight}
              onAction={sendNewMessage}
            />
            {lastAssistantText && (
              <Action.CopyToClipboard
                title="Copy Last Response"
                content={lastAssistantText}
              />
            )}
            <Action.CopyToClipboard
              title="Copy Full Conversation"
              content={messages.map((msg) => {
                if (typeof msg.content === 'string') {
                  return `${msg.role}: ${msg.content}`;
                } else if (Array.isArray(msg.content)) {
                  const textParts = msg.content
                    .filter(c => c.type === "text")
                    .map(c => c.text)
                    .join(" ");
                  const imageCount = msg.content.filter(c => c.type === "image_url").length;
                  return `${msg.role}: ${imageCount > 0 ? `[${imageCount} Image${imageCount > 1 ? 's' : ''}] ` : ''}${textParts}`;
                }
                return `${msg.role}: [Unknown content]`;
              }).join("\n\n")}
            />
          </ActionPanel.Section>
          <ActionPanel.Section title="Navigation">
            <Action
              title="Back to Menu"
              icon={Icon.ArrowLeft}
              onAction={pop}
            />
          </ActionPanel.Section>
        </ActionPanel>
      }
      metadata={
        <Detail.Metadata>
          <Detail.Metadata.Label title="Messages" text={messages.length.toString()} />
          <Detail.Metadata.Label title="Characters" text={conversationMarkdown.length.toString()} />
          <Detail.Metadata.Separator />
          <Detail.Metadata.TagList title="Status">
            <Detail.Metadata.TagList.Item
              text={isLoading ? "Thinking..." : "Ready"}
              color={isLoading ? Color.Orange : Color.Green}
            />
          </Detail.Metadata.TagList>
        </Detail.Metadata>
      }
    />
  );
}

function ResultView({ result, clipboardData, hotkey }: { 
  result: string; 
  clipboardData: EnhancedClipboardData; 
  hotkey: HotKey 
}) {
  const { push, pop } = useNavigation();
  const preferences = getPreferenceValues<Preferences>();

  const expandToChat = useCallback(async () => {
    const userContent = createMessageContent(hotkey.prompt, clipboardData);
    const initialMessages: ChatMessage[] = [
      { role: "user", content: userContent },
      { role: "assistant", content: result },
    ];
    push(<ChatView initialMessages={initialMessages} />);
  }, [result, clipboardData, hotkey, push]);

  const regenerateResponse = useCallback(async () => {
    try {
      showToast({
        style: Toast.Style.Animated,
        title: "Regenerating response...",
      });

      const userContent = createMessageContent(hotkey.prompt, clipboardData);
      const messages: ChatMessage[] = [
        { role: "user", content: userContent },
      ];

      const newResult = await callOpenAI(messages, preferences);
      push(<ResultView result={newResult} clipboardData={clipboardData} hotkey={hotkey} />);

      showToast({
        style: Toast.Style.Success,
        title: "Response regenerated",
      });
    } catch (error) {
      showToast({
        style: Toast.Style.Failure,
        title: "Error",
        message: error instanceof Error ? error.message : "Failed to regenerate response",
      });
    }
  }, [clipboardData, hotkey, preferences, push]);

  return (
    <Detail
      markdown={`# ${hotkey.title}

${result}`}
      actions={
        <ActionPanel>
          <ActionPanel.Section title="Result Actions">
            <Action.CopyToClipboard
              title="Copy Result"
              content={result}
            />
            <Action
              title="Expand to Chat"
              icon={Icon.Message}
              onAction={expandToChat}
            />
            <Action
              title="Regenerate"
              icon={Icon.ArrowClockwise}
              onAction={regenerateResponse}
            />
          </ActionPanel.Section>
          <ActionPanel.Section title="Navigation">
            <Action
              title="Back to Menu"
              icon={Icon.ArrowLeft}
              onAction={pop}
            />
          </ActionPanel.Section>
        </ActionPanel>
      }
      metadata={
        <Detail.Metadata>
          <Detail.Metadata.Label title="Action" text={hotkey.title} />
          <Detail.Metadata.Label title="Characters" text={result.length.toString()} />
          <Detail.Metadata.Label title="Words" text={result.split(' ').length.toString()} />
          {clipboardData.images && clipboardData.images.length > 0 && (
            <Detail.Metadata.Label 
              title="Images" 
              text={clipboardData.images.length.toString()} 
            />
          )}
        </Detail.Metadata>
      }
    />
  );
}

function MainMenu() {
  const [clipboardData, setClipboardData] = useState<EnhancedClipboardData>({ type: "empty" });
  const [hotkeys, setHotkeys] = useState<HotKey[]>(DEFAULT_HOTKEYS);
  const [isLoading, setIsLoading] = useState(false);
  const { push } = useNavigation();
  const preferences = getPreferenceValues<Preferences>();

  const loadClipboard = useCallback(async () => {
    const data = await loadClipboardData();
    setClipboardData(data);
  }, []);

  const loadHotkeys = useCallback(() => {
    try {
      if (preferences.hotkeys?.trim()) {
        const savedHotkeys = JSON.parse(preferences.hotkeys);
        setHotkeys(savedHotkeys);
      } else {
        setHotkeys(DEFAULT_HOTKEYS);
      }
    } catch (error) {
      console.error("Error loading hotkeys:", error);
      setHotkeys(DEFAULT_HOTKEYS);
    }
  }, [preferences.hotkeys]);

  useEffect(() => {
    loadClipboard();
    loadHotkeys();
  }, [loadClipboard, loadHotkeys]);

  const executeHotkey = useCallback(async (hotkey: HotKey) => {
    if (!preferences.apiKey?.trim()) {
      showToast({
        style: Toast.Style.Failure,
        title: "API Key Required",
        message: "Please set your OpenAI API key in preferences",
      });
      openExtensionPreferences();
      return;
    }

    if (clipboardData.type === "empty") {
      showToast({
        style: Toast.Style.Failure,
        title: "No Content",
        message: "No text or image found in clipboard",
      });
      return;
    }

    setIsLoading(true);
    showToast({
      style: Toast.Style.Animated,
      title: `Executing ${hotkey.title}...`,
    });

    try {
      const userContent = createMessageContent(hotkey.prompt, clipboardData);
      const messages: ChatMessage[] = [
        { role: "user", content: userContent },
      ];

      const result = await callOpenAI(messages, preferences);
      push(<ResultView result={result} clipboardData={clipboardData} hotkey={hotkey} />);

      showToast({
        style: Toast.Style.Success,
        title: "Response generated",
      });
    } catch (error) {
      showToast({
        style: Toast.Style.Failure,
        title: "Error",
        message: error instanceof Error ? error.message : "Failed to process request",
      });
    } finally {
      setIsLoading(false);
    }
  }, [preferences, clipboardData, push]);

  const startChat = useCallback(async () => {
    if (!preferences.apiKey?.trim()) {
      showToast({
        style: Toast.Style.Failure,
        title: "API Key Required",
        message: "Please set your OpenAI API key in preferences",
      });
      openExtensionPreferences();
      return;
    }

    if (clipboardData.type === "empty") {
      showToast({
        style: Toast.Style.Failure,
        title: "No Content",
        message: "No text or image found in clipboard",
      });
      return;
    }

    setIsLoading(true);
    showToast({
      style: Toast.Style.Animated,
      title: "Starting chat...",
    });

    try {
      const userContent = createMessageContent("", clipboardData);
      const userMessage: ChatMessage = { role: "user", content: userContent };
      push(<ChatView initialMessages={[userMessage]} />);

      showToast({
        style: Toast.Style.Success,
        title: "Chat started",
      });
    } catch (error) {
      showToast({
        style: Toast.Style.Failure,
        title: "Error",
        message: error instanceof Error ? error.message : "Failed to start chat",
      });
    } finally {
      setIsLoading(false);
    }
  }, [preferences, clipboardData, push]);

  const hasValidClipboard = clipboardData.type !== "empty";

  const getClipboardPreview = () => {
    const parts: string[] = [];
    
    if (clipboardData.text) {
      const textPreview = clipboardData.text.length > 100
        ? `${clipboardData.text.substring(0, 100)}...`
        : clipboardData.text;
      parts.push(textPreview);
    }
    
    if (clipboardData.images && clipboardData.images.length > 0) {
      parts.push(`[${clipboardData.images.length} image${clipboardData.images.length > 1 ? 's' : ''}]`);
    }
    
    return parts.length > 0 ? parts.join(" ") : "No content in clipboard";
  };

  const getClipboardCharCount = () => {
    let count = clipboardData.text?.length || 0;
    if (clipboardData.images && clipboardData.images.length > 0) {
      count += clipboardData.images.length * 1000; // Rough estimate for image "size"
    }
    return count;
  };

  const getClipboardIcon = () => {
    switch (clipboardData.type) {
      case "text":
        return Icon.Text;
      case "image":
        return Icon.Image;
      case "mixed":
        return Icon.Document;
      default:
        return Icon.ExclamationMark;
    }
  };

  const settingActionPanel = (
    <ActionPanel.Section title="Settings">
      <Action
        title="Manage Hotkeys"
        icon={Icon.Gear}
        onAction={() => push(<HotkeysSettingsView />)}
      />
      <Action
        title="Open Extension Preferences"
        icon={Icon.Cog}
        onAction={openExtensionPreferences}
      />
      <Action
        title="Refresh Clipboard"
        icon={Icon.ArrowClockwise}
        onAction={loadClipboard}
      />
    </ActionPanel.Section>
  );

  return (
    <List
      isLoading={isLoading}
      searchBarPlaceholder="Search hotkeys..."
      actions={
        <ActionPanel>
          {settingActionPanel}
        </ActionPanel>
      }
    >
      <List.Section title="Chat">
        <List.Item
          title="Start Chat"
          subtitle={`Begin conversation with clipboard ${clipboardData.type}`}
          icon={Icon.Message}
          accessories={[
            {
              tag: hasValidClipboard ? "Ready" : "No content",
              icon: getClipboardIcon()
            }
          ]}
          actions={
            <ActionPanel>
              <Action
                title="Start Chat"
                icon={Icon.Message}
                onAction={startChat}
              />
              {settingActionPanel}
            </ActionPanel>
          }
        />
      </List.Section>

      <List.Section title="Quick Actions">
        {hotkeys.map((hotkey) => (
          <List.Item
            key={hotkey.id}
            title={hotkey.title}
            subtitle={hotkey.subtitle}
            icon={hotkey.icon}
            accessories={[
              {
                tag: clipboardData.type !== "empty" ? "Ready" : "No content",
                icon: getClipboardIcon()
              }
            ]}
            actions={
              <ActionPanel>
                <Action
                  title={hotkey.title}
                  icon={hotkey.icon}
                  onAction={() => executeHotkey(hotkey)}
                />
                {settingActionPanel}
              </ActionPanel>
            }
          />
        ))}
      </List.Section>

      <List.Section title="Clipboard Preview">
        <List.Item
          title={`Current Clipboard (${clipboardData.type})`}
          subtitle={getClipboardPreview()}
          icon={getClipboardIcon()}
          accessories={[
            {
              text: hasValidClipboard ? `~${getClipboardCharCount()} chars` : undefined,
              tag: hasValidClipboard ? "Ready" : "Empty",
              icon: getClipboardIcon()
            }
          ]}
          actions={
            <ActionPanel>
              <Action
                title="Refresh Clipboard"
                icon={Icon.ArrowClockwise}
                onAction={loadClipboard}
              />
              {clipboardData.text && (
                <Action.CopyToClipboard
                  title="Copy Clipboard Text"
                  content={clipboardData.text}
                />
              )}
              {settingActionPanel}
            </ActionPanel>
          }
        />
      </List.Section>
    </List>
  );
}

export default function Command() {
  return <MainMenu />;
}
