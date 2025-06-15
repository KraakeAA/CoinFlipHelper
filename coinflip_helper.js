// coinflip_helper.js
// This is a new, separate file for your Coinflip bot. It runs independently from index.js.

import 'dotenv/config';
import TelegramBot from 'node-telegram-bot-api';
import { Pool } from 'pg';

// --- CONFIGURATION ---
const BOT_TOKEN = process.env.COINFLIP_BOT_TOKEN;
const DATABASE_URL = process.env.DATABASE_URL;
const BOT_ID = BOT_TOKEN.split(':')[0]; // Get bot's ID from its token

if (!BOT_TOKEN || !DATABASE_URL) {
    console.error("COINFLIP HELPER: CRITICAL: COINFLIP_BOT_TOKEN or DATABASE_URL is missing from environment variables.");
    process.exit(1);
}

const bot = new TelegramBot(BOT_TOKEN, { polling: true });
const pool = new Pool({
    connectionString: DATABASE_URL,
    ssl: process.env.DB_SSL === 'true' ? { rejectUnauthorized: process.env.DB_REJECT_UNAUTHORIZED === 'true' } : false,
});

const activeHelperGames = new Map();

// --- CONSTANTS ---
const UNIFIED_OFFER_TIMEOUT_MS = parseInt(process.env.UNIFIED_OFFER_TIMEOUT_MS, 10) || 30000;
const DIRECT_CHALLENGE_ACCEPT_TIMEOUT_MS = parseInt(process.env.DIRECT_CHALLENGE_ACCEPT_TIMEOUT_MS, 10) || 45000;
const ACTIVE_GAME_TURN_TIMEOUT_MS = parseInt(process.env.ACTIVE_GAME_TURN_TIMEOUT_MS, 10) || 45000;

const COINFLIP_CHOICE_HEADS = 'heads';
const COINFLIP_CHOICE_TAILS = 'tails';
const COIN_EMOJI_DISPLAY = '🪙';
const COIN_FLIP_ANIMATION_FRAMES = ['🌕', '🌖', '🌗', '🌘', '🌑', '🌒', '🌓', '🌔'];
const COIN_FLIP_ANIMATION_INTERVAL_MS = 250;

// --- UTILITY FUNCTIONS ---
function escapeHTML(text) {
    if (text === null || typeof text === 'undefined') return '';
    return String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#039;');
}

async function safeSendMessage(chatId, text, options = {}) {
    try {
        return await bot.sendMessage(chatId, text, options);
    } catch (e) {
        console.error(`[CoinflipHelper] Failed to send message to ${chatId}: ${e.message}`);
        return null;
    }
}

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// --- DATABASE INTERACTION ---

/**
 * Writes the final result of a game to the database.
 * This triggers a notification to the main bot for financial settlement.
 * @param {number} sessionId - The database ID of the session.
 * @param {string} finalStatus - The status to set, e.g., 'completed_p1_win'.
 * @param {object} finalGameState - The final game state JSON to store.
 */
async function finalizeAndRecordOutcome(sessionId, finalStatus, finalGameState = {}) {
    const logPrefix = `[CoinflipHelper_Finalize SID:${sessionId}]`;
    console.log(`${logPrefix} Finalizing game with status: ${finalStatus}`);
    try {
        // The AFTER UPDATE trigger on this table notifies the main bot.
        await pool.query(
            "UPDATE coinflip_sessions SET status = $1, game_state_json = $2, updated_at = NOW() WHERE session_id = $3",
            [finalStatus, JSON.stringify(finalGameState), sessionId]
        );
        activeHelperGames.delete(sessionId);
    } catch (e) {
        console.error(`${logPrefix} CRITICAL: Failed to write final outcome to DB: ${e.message}`);
    }
}

// --- CORE GAME LOGIC (PORTED FROM index.js) ---

/**
 * Manages the UI for a unified offer (PvB vs PvP).
 * @param {object} session - The game session object from the database.
 */
async function runUnifiedOffer(session) {
    const gameState = session.game_state_json || {};
    const initiatorName = escapeHTML(gameState.initiatorName || `Player ${session.initiator_id}`);
    const betAmountDisplay = `${(Number(session.bet_amount_lamports) / 1e9).toFixed(4)} SOL`;

    const messageText = `🪙 <b>Coinflip Challenge</b>\n\n${initiatorName} has wagered <b>${betAmountDisplay}</b>.\n\nWho will face them?`;
    const keyboard = {
        inline_keyboard: [
            [{ text: "🤖 Challenge Bot", callback_data: `cf_helper_accept_bot:${session.session_id}` }],
            [{ text: "⚔️ Accept PvP", callback_data: `cf_helper_accept_pvp:${session.session_id}` }],
            [{ text: "🚫 Cancel (Initiator)", callback_data: `cf_helper_cancel:${session.session_id}` }]
        ]
    };

    const sentMessage = await safeSendMessage(session.chat_id, messageText, { parse_mode: 'HTML', reply_markup: keyboard });
    if (sentMessage) {
        session.game_state_json.helperMessageId = sentMessage.message_id;
        session.timeoutId = setTimeout(() => handleOfferTimeout(session.session_id), UNIFIED_OFFER_TIMEOUT_MS);
        await pool.query("UPDATE coinflip_sessions SET game_state_json = $1 WHERE session_id = $2", [JSON.stringify(session.game_state_json), session.session_id]);
        activeHelperGames.set(session.session_id, session);
    } else {
        await finalizeAndRecordOutcome(session.session_id, 'completed_error_ui', { error: "Failed to send offer message" });
    }
}

/**
 * Manages the UI for a direct PvP challenge.
 * @param {object} session - The game session object from the database.
 */
async function runDirectChallenge(session) {
    const gameState = session.game_state_json || {};
    const initiatorName = escapeHTML(gameState.initiatorName || `Player ${session.initiator_id}`);
    const opponentName = escapeHTML(gameState.opponentName || `Player ${session.opponent_id}`);
    const betAmountDisplay = `${(Number(session.bet_amount_lamports) / 1e9).toFixed(4)} SOL`;

    const messageText = `Hey ${opponentName}❗\n\n${initiatorName} has challenged you to a <b>Coinflip</b> duel for <b>${betAmountDisplay}</b>!`;
    const keyboard = {
        inline_keyboard: [
            [{ text: "✅ Accept Challenge", callback_data: `cf_helper_accept_direct:${session.session_id}` }],
            [{ text: "❌ Decline Challenge", callback_data: `cf_helper_decline_direct:${session.session_id}` }],
            [{ text: "🚫 Withdraw (Initiator)", callback_data: `cf_helper_cancel:${session.session_id}` }]
        ]
    };
    const sentMessage = await safeSendMessage(session.chat_id, messageText, { parse_mode: 'HTML', reply_markup: keyboard });
     if (sentMessage) {
        session.game_state_json.helperMessageId = sentMessage.message_id;
        session.timeoutId = setTimeout(() => handleOfferTimeout(session.session_id), DIRECT_CHALLENGE_ACCEPT_TIMEOUT_MS);
        await pool.query("UPDATE coinflip_sessions SET game_state_json = $1 WHERE session_id = $2", [JSON.stringify(session.game_state_json), session.session_id]);
        activeHelperGames.set(session.session_id, session);
    } else {
        await finalizeAndRecordOutcome(session.session_id, 'completed_error_ui', { error: "Failed to send direct challenge message" });
    }
}

/**
 * Handles the game flow for a Player vs. Bot coinflip game.
 * @param {object} session - The game session object.
 */
async function runCoinflipPvB(session) {
    const gameState = session.game_state_json;
    const playerRefHTML = escapeHTML(gameState.initiatorName);

    const titleHTML = `🤖${COIN_EMOJI_DISPLAY} <b>Coinflip: ${playerRefHTML} vs. Bot Dealer!</b> ${COIN_EMOJI_DISPLAY}🤖`;
    const initialMessageTextHTML = `${titleHTML}\n\n${playerRefHTML}, make your call: Heads or Tails?`;
    const keyboard = {
        inline_keyboard: [
            [{ text: `${COIN_EMOJI_DISPLAY} Heads`, callback_data: `cf_helper_pvb_choice:${session.session_id}:${COINFLIP_CHOICE_HEADS}` }],
            [{ text: `${COIN_EMOJI_DISPLAY} Tails`, callback_data: `cf_helper_pvb_choice:${session.session_id}:${COINFLIP_CHOICE_TAILS}` }]
        ]
    };
    await bot.editMessageText(initialMessageTextHTML, { chat_id: session.chat_id, message_id: gameState.helperMessageId, parse_mode: 'HTML', reply_markup: keyboard });

    session.timeoutId = setTimeout(() => handleGameTimeout(session.session_id, 'player_turn'), ACTIVE_GAME_TURN_TIMEOUT_MS);
    activeHelperGames.set(session.session_id, session);
}

/**
 * Handles the game flow for a Player vs. Player coinflip game.
 * @param {object} session - The game session object.
 */
async function runCoinflipPvP(session) {
    const gameState = session.game_state_json;
    const p1MentionHTML = escapeHTML(gameState.initiatorName);
    const p2MentionHTML = escapeHTML(gameState.opponentName);

    const p1IsCaller = Math.random() < 0.5;
    const caller = p1IsCaller ? { id: session.initiator_id, name: p1MentionHTML } : { id: session.opponent_id, name: p2MentionHTML };
    session.game_state_json.callerId = caller.id;
    
    const titleHTML = `✨⚔️ <b>Coinflip PvP: ${p1MentionHTML} vs ${p2MentionHTML}!</b> ⚔️✨`;
    const messageTextHTML = `${titleHTML}\n\nFate has decreed that <b>${caller.name}</b> shall make the fateful call! What is your prediction?`;
    const keyboard = {
        inline_keyboard: [[
            { text: `🪙 Heads`, callback_data: `cf_helper_pvp_choice:${session.session_id}:${caller.id}:${COINFLIP_CHOICE_HEADS}` },
            { text: `🪙 Tails`, callback_data: `cf_helper_pvp_choice:${session.session_id}:${caller.id}:${COINFLIP_CHOICE_TAILS}` }
        ]]
    };

    await bot.editMessageText(messageTextHTML, { chat_id: session.chat_id, message_id: gameState.helperMessageId, parse_mode: 'HTML', reply_markup: keyboard });
    
    session.timeoutId = setTimeout(() => handleGameTimeout(session.session_id, 'caller_turn'), ACTIVE_GAME_TURN_TIMEOUT_MS);
    activeHelperGames.set(session.session_id, session);
}


/**
 * Runs the coin flip animation and determines the final result.
 * @param {object} session - The game session object.
 * @param {string} playerChoice - The player's choice ('heads' or 'tails').
 * @param {boolean} isPvP - Flag to determine if it's a PvP game.
 */
async function runCoinflipAnimation(session, playerChoice, isPvP = false) {
    if (session.timeoutId) clearTimeout(session.timeoutId);
    
    const gameState = session.game_state_json;
    const playerRefHTML = isPvP ? escapeHTML(gameState.callerName) : escapeHTML(gameState.initiatorName);
    const choiceDisplay = escapeHTML(playerChoice.charAt(0).toUpperCase() + playerChoice.slice(1));
    const titleFlippingHTML = `💫 ${COIN_EMOJI_DISPLAY} <b>Coin in the Air!</b> ${COIN_EMOJI_DISPLAY} 💫`;
    let flippingMessageText = `${titleFlippingHTML}\n\n${playerRefHTML} called <b>${choiceDisplay}</b>!\nThe coin is spinning wildly!\n\n`;

    // Animation loop
    const steps = 8;
    for (let i = 0; i < steps; i++) {
        const frame = COIN_FLIP_ANIMATION_FRAMES[i % COIN_FLIP_ANIMATION_FRAMES.length];
        try {
            await bot.editMessageText(flippingMessageText + `<b>${frame}</b>`, { chat_id: session.chat_id, message_id: gameState.helperMessageId, parse_mode: 'HTML' });
        } catch (e) { if (!e.message?.includes("message is not modified")) break; }
        await sleep(COIN_FLIP_ANIMATION_INTERVAL_MS);
    }

    const actualFlipOutcome = Math.random() < 0.5 ? COINFLIP_CHOICE_HEADS : COINFLIP_CHOICE_TAILS;
    const resultDisplay = escapeHTML(actualFlipOutcome.charAt(0).toUpperCase() + actualFlipOutcome.slice(1));
    const playerWins = playerChoice === actualFlipOutcome;
    
    let winnerId, loserId, finalStatus;
    
    if (isPvP) {
        winnerId = playerWins ? gameState.callerId : (String(gameState.callerId) === String(session.initiator_id) ? session.opponent_id : session.initiator_id);
        finalStatus = String(winnerId) === String(session.initiator_id) ? 'completed_p1_win' : 'completed_p2_win';
        gameState.winner = winnerId;
    } else {
        winnerId = playerWins ? session.initiator_id : 'bot';
        finalStatus = playerWins ? 'completed_p1_win' : 'completed_bot_win';
        gameState.winner = winnerId;
    }
    
    const winnerName = (String(winnerId) === String(session.initiator_id)) ? gameState.initiatorName : gameState.opponentName || 'The Bot';
    const finalMessageHTML = `${titleFlippingHTML}\n\nThe coin landed on... ✨ <b>${COIN_EMOJI_DISPLAY} ${resultDisplay}!</b> ✨\n\n${playerWins ? 'Congratulations' : 'Unfortunately'}, <b>${escapeHTML(winnerName)}</b> wins this round!\n\nThe main bot will now settle the wagers.`;

    await bot.editMessageText(finalMessageHTML, { chat_id: session.chat_id, message_id: gameState.helperMessageId, parse_mode: 'HTML' });
    
    await finalizeAndRecordOutcome(session.session_id, finalStatus, gameState);
}

// --- TIMEOUT HANDLERS ---

async function handleOfferTimeout(sessionId) {
    const session = activeHelperGames.get(sessionId);
    if (!session || session.status !== 'in_progress') return;
    
    await bot.editMessageText(`⏳ This Coinflip offer has expired unanswered.`, { chat_id: session.chat_id, message_id: session.game_state_json.helperMessageId, parse_mode: 'HTML' });
    await finalizeAndRecordOutcome(sessionId, 'completed_timeout', session.game_state_json);
}

async function handleGameTimeout(sessionId, turnType) {
     const session = activeHelperGames.get(sessionId);
    if (!session || session.status !== 'in_progress') return;

    let finalStatus = 'completed_timeout';
    if(turnType === 'caller_turn') {
        const callerId = session.game_state_json.callerId;
        finalStatus = String(callerId) === String(session.initiator_id) ? 'completed_p2_win' : 'completed_p1_win';
    } else { // Player vs Bot
        finalStatus = 'completed_bot_win';
    }

    await bot.editMessageText(`⏳ Player timed out. The game is over.`, { chat_id: session.chat_id, message_id: session.game_state_json.helperMessageId, parse_mode: 'HTML' });
    await finalizeAndRecordOutcome(sessionId, finalStatus, session.game_state_json);
}


// --- MAIN LISTENERS ---

bot.on('callback_query', async (callbackQuery) => {
    const data = callbackQuery.data;
    const [action, sessionIdStr, ...params] = data.split(':');
    const sessionId = parseInt(sessionIdStr, 10);
    const clickerId = String(callbackQuery.from.id);
    
    const session = activeHelperGames.get(sessionId);
    if (!session) {
        await bot.answerCallbackQuery(callbackQuery.id, { text: "This game is no longer active.", show_alert: true });
        return;
    }

    // Clear any existing timeout since the user interacted
    if (session.timeoutId) clearTimeout(session.timeoutId);

    switch(action) {
        case 'cf_helper_cancel':
            if (clickerId === String(session.initiator_id)) {
                await bot.answerCallbackQuery(callbackQuery.id, { text: "Offer cancelled." });
                await bot.deleteMessage(session.chat_id, session.game_state_json.helperMessageId).catch(() => {});
                await finalizeAndRecordOutcome(sessionId, 'completed_cancelled', session.game_state_json);
            } else {
                await bot.answerCallbackQuery(callbackQuery.id, { text: "Only the initiator can cancel.", show_alert: true });
            }
            break;
        case 'cf_helper_accept_bot':
            if (clickerId === String(session.initiator_id)) {
                await runCoinflipPvB(session);
            } else {
                 await bot.answerCallbackQuery(callbackQuery.id, { text: "Only the initiator can play vs the Bot.", show_alert: true });
            }
            break;
        case 'cf_helper_accept_pvp':
            if (clickerId !== String(session.initiator_id)) {
                session.opponent_id = clickerId;
                session.game_state_json.opponentName = getRawPlayerDisplayReference(callbackQuery.from);
                await runCoinflipPvP(session);
            } else {
                await bot.answerCallbackQuery(callbackQuery.id, { text: "You can't accept your own challenge.", show_alert: true });
            }
            break;
        case 'cf_helper_pvb_choice':
            if (clickerId === String(session.initiator_id)) {
                const choice = params[0];
                await runCoinflipAnimation(session, choice, false);
            }
            break;
        case 'cf_helper_pvp_choice':
            const callerId = params[0];
            const choice = params[1];
            if (clickerId === String(callerId)) {
                session.game_state_json.callerName = getRawPlayerDisplayReference(callbackQuery.from);
                await runCoinflipAnimation(session, choice, true);
            } else {
                 await bot.answerCallbackQuery(callbackQuery.id, { text: "It's not your turn to call.", show_alert: true });
            }
            break;
    }
});


async function listenForNewGames() {
    const client = await pool.connect();
    client.on('notification', (msg) => {
        if (msg.channel === 'coinflip_session_pickup') {
            try {
                const payload = JSON.parse(msg.payload);
                if (payload.main_bot_game_id) {
                    console.log(`[CoinflipHelper] Received pickup notification for ${payload.main_bot_game_id}`);
                    handleNewGameSession(payload.main_bot_game_id);
                }
            } catch (e) {
                console.error("[CoinflipHelper] Error parsing notification payload:", e);
            }
        }
    });
    await client.query('LISTEN coinflip_session_pickup');
    const self = await bot.getMe();
    console.log(`✅ Coinflip Helper Bot (@${self.username}) is online and listening for games...`);
}

listenForNewGames().catch(e => {
    console.error("FATAL: Failed to start Coinflip Helper listener:", e);
    process.exit(1);
});
