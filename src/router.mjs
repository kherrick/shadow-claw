/**
 * ShadowClaw — Message router
 * Routes outbound messages and typing indicators to the correct channel
 * based on the groupId prefix.
 */

import "./types.mjs"; // Import types

/**
 * Routes outbound messages and typing indicators to different channels
 * Prefix mapping:
 *   "br:"  → BrowserChatChannel
 */
export class Router {
  /**
   * @param {import('./types.mjs').Channel} browserChat
   */
  constructor(browserChat) {
    this.browserChat = browserChat;
  }

  /**
   * Send a message to the correct channel
   * @param {string} groupId
   * @param {string} text
   * @returns {Promise<void>}
   */
  async send(groupId, text) {
    const channel = this.findChannel(groupId);
    if (!channel) {
      console.warn(`No channel for groupId: ${groupId}`);
      return;
    }
    await channel.send(groupId, text);
  }

  /**
   * Set typing indicator on the correct channel
   * @param {string} groupId
   * @param {boolean} typing
   */
  setTyping(groupId, typing) {
    const channel = this.findChannel(groupId);
    channel?.setTyping(groupId, typing);
  }

  /**
   * Strip internal tags from agent output
   * @param {string} rawText
   * @returns {string}
   */
  static formatOutbound(rawText) {
    return rawText.replace(/<internal>[\s\S]*?<\/internal>/g, "").trim();
  }

  /**
   * Format messages in XML for agent context
   * @param {any[]} messages
   * @returns {string}
   */
  static formatMessagesXml(messages) {
    const escapeXml = (/** @type {string} */ s) =>
      s
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");

    const lines = messages.map(
      (m) =>
        `<message sender="${escapeXml(m.sender)}" time="${new Date(m.timestamp).toISOString()}">${escapeXml(m.content)}</message>`,
    );
    return `<messages>\n${lines.join("\n")}\n</messages>`;
  }

  /**
   * Find the appropriate channel for a groupId

   * @param {string} groupId
   * @returns {import('./types.mjs').Channel|null}
   */
  findChannel(groupId) {
    return this.browserChat;
  }
}
