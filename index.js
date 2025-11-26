// index.js — Welcomer (uses provided image URL)
// Behavior:
// - Immediately sends your image as a large welcome panel attachment on join.
// - Shows Page 1 (Where did you find us?) with Friend / Discord / Other (Other opens modal).
// - Next disabled until a choice is made. Next opens Page 2 (info).
// - Confirm finalizes: stores counts, DMs the user with a "super cool tech" embed, assigns role (optional), sends pro chart to owner (DM/fallback).
// - Commands: !ping, !status, !testwelcome

// Safe dotenv (Railway doesn't need it, but local dev will)
try { require('dotenv').config(); } catch (e) {}

// Imports
const fs = require('fs');
const path = require('path');
const fetch = require('node-fetch'); // v2
const {
  Client,
  GatewayIntentBits,
  Partials,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  Events,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  InteractionType,
  AttachmentBuilder
} = require('discord.js');

// --- CONFIG (env) ---
const TOKEN = process.env.TOKEN;
const WELCOME_CHANNEL_ID = process.env.WELCOME_CHANNEL_ID;
const OWNER_ID = process.env.OWNER_ID;
const WELCOME_ROLE_NAME = process.env.WELCOME_ROLE_NAME || 'FAMILY MEMBERS';

console.log('TOKEN Loaded:', !!TOKEN);
console.log('WELCOME_CHANNEL_ID Loaded:', !!WELCOME_CHANNEL_ID);
console.log('OWNER_ID Loaded:', !!OWNER_ID);
console.log('WELCOME_ROLE_NAME:', WELCOME_ROLE_NAME);

// --- IMAGE URL (you provided this) ---
const WELCOME_IMAGE_URL = 'https://img.sanishtech.com/u/450ba4d8410a77001bb7e1e4980af5cb.png';

// --- STORAGE ---
const STORAGE_FILE = path.join(__dirname, 'engagement_counts.json');
if (!fs.existsSync(STORAGE_FILE)) {
  fs.writeFileSync(STORAGE_FILE, JSON.stringify({ choices: {} }, null, 2));
}
function readCounts(){ return JSON.parse(fs.readFileSync(STORAGE_FILE,'utf8')); }
function writeCounts(d){ fs.writeFileSync(STORAGE_FILE, JSON.stringify(d, null, 2)); }

// --- SESSION state (in-memory short-lived) ---
const sessions = {}; // { memberId: { q1: null, q1raw: null, page:1, messageId, channelId } }

// --- Discord client ---
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.DirectMessages
  ],
  partials: [Partials.Channel]
});

client.once(Events.ClientReady, () => {
  console.log(`Logged in as ${client.user.tag} (${client.user.id})`);
});

// ---------------- Chart helpers (QuickChart) ----------------
async function buildChartBuffer(countsObj, lastChoiceLabel, whoTag) {
  const labels = Object.keys(countsObj);
  const data = labels.map(l => countsObj[l]);
  const chartConfig = {
    type: 'bar',
    data: {
      labels,
      datasets: [{
        label: 'New members',
        data,
        backgroundColor: ['rgba(54,162,235,0.95)','rgba(75,192,192,0.95)','rgba(153,102,255,0.95)'],
        borderRadius: 8,
        barPercentage: 0.6
      }]
    },
    options: {
      layout:{ padding:12 },
      plugins:{
        title:{ display:true, text:'Where members discover the server', font:{ size:18 } },
        subtitle:{ display:true, text:`Last: ${lastChoiceLabel} — by ${whoTag}`, font:{ size:12 } },
        legend:{ display:false }
      },
      scales:{
        x:{ grid:{ display:false } },
        y:{ beginAtZero:true, grid:{ color:'rgba(255,255,255,0.06)' }, ticks:{ stepSize:1 } }
      },
      backgroundColor: '#0b0b0d'
    }
  };

  const qcUrl = `https://quickchart.io/chart?c=${encodeURIComponent(JSON.stringify(chartConfig))}&w=1000&h=500&format=png&version=3`;
  const res = await fetch(qcUrl);
  if (!res.ok) throw new Error(`Chart fetch failed: ${res.status}`);
  return await res.buffer();
}

async function sendChartToOwner(countsObj, lastChoiceLabel, whoTag, guild) {
  try {
    const buffer = await buildChartBuffer(countsObj, lastChoiceLabel, whoTag);
    const att = new AttachmentBuilder(buffer, { name: 'engagement_chart.png' });

    // Try DM owner
    try {
      const owner = await client.users.fetch(OWNER_ID);
      if (owner) {
        await owner.send({ content: `New answer: **${lastChoiceLabel}** (by ${whoTag}) — latest engagement:`, files: [att] });
        return;
      }
    } catch (err) {
      console.warn('Could not DM owner; falling back to channel:', err);
    }

    // fallback: post to welcome channel
    try {
      if (guild) {
        const ch = guild.channels.cache.get(WELCOME_CHANNEL_ID);
        if (ch) await ch.send({ content: 'Latest engagement chart:', files: [att] });
      }
    } catch (err) {
      console.error('Fallback chart post failed:', err);
    }
  } catch (err) {
    console.error('sendChartToOwner error:', err);
  }
}

// ---------------- UI builders ----------------
function buildPage1EmbedText() {
  return new EmbedBuilder()
    .setTitle('Question 1 of 2 — Where did you find us?')
    .setDescription('Choose one option below. If you select **Other**, you will be asked to type where.')
    .setColor(0x0b69ff);
}
function buildPage2EmbedText(q1Label) {
  return new EmbedBuilder()
    .setTitle('Question 2 of 2 — About this channel')
    .setDescription(
      `This server focuses on **Cosmos Esports** — competitive gaming, events, and community.\n\n` +
      `• 🎮 Tournaments & scrims\n• 🧠 Guides & coaching\n• 💬 Chill zone & team recruiting\n\nYour selection: **${q1Label}**. Click **Confirm** when ready.`
    )
    .setColor(0x0b69ff);
}

// ---------------- Start welcome flow (uses remote image URL) ----------------
async function startWelcomeFor(memberLike) {
  try {
    const channel = memberLike.guild.channels.cache.get(WELCOME_CHANNEL_ID);
    if (!channel) {
      console.error('Invalid WELCOME_CHANNEL_ID or missing perms:', WELCOME_CHANNEL_ID);
      return { ok:false, reason:'invalid_channel' };
    }

    // Fetch the remote image buffer once and send as attachment with question message.
    let imgBuffer = null;
    try {
      const r = await fetch(WELCOME_IMAGE_URL);
      if (r.ok) imgBuffer = await r.buffer();
      else console.warn('Welcome image fetch failed status', r.status);
    } catch (err) {
      console.warn('Welcome image fetch error:', err);
    }

    // initialize session
    sessions[memberLike.id] = { q1: null, q1raw: null, page: 1, messageId: null, channelId: channel.id };

    // Build buttons (Next disabled initially)
    const btnFriend = new ButtonBuilder().setCustomId(`q1_friend_${memberLike.id}`).setLabel('Friend').setStyle(ButtonStyle.Secondary);
    const btnDiscord = new ButtonBuilder().setCustomId(`q1_discord_${memberLike.id}`).setLabel('Discord').setStyle(ButtonStyle.Primary);
    const btnOther = new ButtonBuilder().setCustomId(`q1_other_${memberLike.id}`).setLabel('Other').setStyle(ButtonStyle.Success);
    const nextBtn = new ButtonBuilder().setCustomId(`q1_next_${memberLike.id}`).setLabel('Next →').setStyle(ButtonStyle.Secondary).setDisabled(true);

    const row1 = new ActionRowBuilder().addComponents(btnFriend, btnDiscord, btnOther);
    const row2 = new ActionRowBuilder().addComponents(nextBtn);

    // Send: attachment (image) + question message with buttons in the same message
    const files = imgBuffer ? [ new AttachmentBuilder(imgBuffer, { name: 'welcome.png' }) ] : [];
    const sent = await channel.send({
      content: `<@${memberLike.id}>`,
      files,
      embeds: [ buildPage1EmbedText() ],
      components: [row1, row2]
    });

    sessions[memberLike.id].messageId = sent.id;
    return { ok:true, message: sent };
  } catch (err) {
    console.error('startWelcomeFor error:', err);
    return { ok:false, reason:'error', error:err };
  }
}

// ---------------- Interaction handler ----------------
client.on(Events.InteractionCreate, async (interaction) => {
  try {
    // Modal submit for Other
    if (interaction.type === InteractionType.ModalSubmit) {
      const match = interaction.customId.match(/^modal_other_(\d+)$/);
      if (match) {
        const targetId = match[1];
        if (interaction.user.id !== targetId) {
          await interaction.reply({ content: 'This modal is not for you.', ephemeral: true });
          return;
        }
        const text = interaction.fields.getTextInputValue('other_input');
        if (!sessions[targetId]) sessions[targetId] = { q1:null, q1raw:null, page:1 };
        sessions[targetId].q1 = 'Other';
        sessions[targetId].q1raw = text;

        // edit the original message to enable Next (rebuild components)
        try {
          const ch = interaction.guild.channels.cache.get(sessions[targetId].channelId);
          if (ch && sessions[targetId].messageId) {
            const msg = await ch.messages.fetch(sessions[targetId].messageId).catch(()=>null);
            if (msg) {
              // create Next enabled
              const nextBtn = new ButtonBuilder().setCustomId(`q1_next_${targetId}`).setLabel('Next →').setStyle(ButtonStyle.Secondary).setDisabled(false);
              const row2 = new ActionRowBuilder().addComponents(nextBtn);
              // keep main choice buttons as-is
              const row1 = new ActionRowBuilder().addComponents(
                new ButtonBuilder().setCustomId(`q1_friend_${targetId}`).setLabel('Friend').setStyle(ButtonStyle.Secondary),
                new ButtonBuilder().setCustomId(`q1_discord_${targetId}`).setLabel('Discord').setStyle(ButtonStyle.Primary),
                new ButtonBuilder().setCustomId(`q1_other_${targetId}`).setLabel('Other').setStyle(ButtonStyle.Success)
              );
              await msg.edit({ embeds: [ buildPage1EmbedText() ], components: [row1, row2] });
            }
          }
        } catch (err) { console.warn('Failed to enable Next after modal:', err); }

        await interaction.reply({ content: 'Thanks — your answer has been recorded. Click Next to continue.', ephemeral: true });
        return;
      }
    }

    if (!interaction.isButton()) return;

    const id = interaction.customId;

    // Q1 choices
    const q1Match = id.match(/^q1_(friend|discord|other)_(\d+)$/);
    if (q1Match) {
      const choiceKey = q1Match[1]; // friend | discord | other
      const memberId = q1Match[2];
      if (interaction.user.id !== memberId) {
        await interaction.reply({ content: 'This question is only for the joining member.', ephemeral: true });
        return;
      }

      // store selection
      if (!sessions[memberId]) sessions[memberId] = { q1:null, q1raw:null, page:1 };
      if (choiceKey === 'friend') { sessions[memberId].q1 = 'Friend'; sessions[memberId].q1raw = 'Friend'; }
      else if (choiceKey === 'discord') { sessions[memberId].q1 = 'Discord'; sessions[memberId].q1raw = 'Discord'; }
      else if (choiceKey === 'other') {
        // show modal for input
        const modal = new ModalBuilder().setCustomId(`modal_other_${memberId}`).setTitle('Which platform did you find us on?');
        const input = new TextInputBuilder().setCustomId('other_input').setLabel('Platform name (e.g. Instagram, Reddit)').setStyle(TextInputStyle.Short).setRequired(true);
        const row = new ActionRowBuilder().addComponents(input);
        modal.addComponents(row);
        await interaction.showModal(modal);
        return;
      }

      // if Friend or Discord, enable Next (edit original message)
      try {
        const ch = interaction.guild.channels.cache.get(sessions[memberId].channelId);
        const msg = ch ? await ch.messages.fetch(sessions[memberId].messageId).catch(()=>null) : null;
        if (msg) {
          const nextBtn = new ButtonBuilder().setCustomId(`q1_next_${memberId}`).setLabel('Next →').setStyle(ButtonStyle.Secondary).setDisabled(false);
          const row2 = new ActionRowBuilder().addComponents(nextBtn);
          const row1 = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId(`q1_friend_${memberId}`).setLabel('Friend').setStyle(ButtonStyle.Secondary),
            new ButtonBuilder().setCustomId(`q1_discord_${memberId}`).setLabel('Discord').setStyle(ButtonStyle.Primary),
            new ButtonBuilder().setCustomId(`q1_other_${memberId}`).setLabel('Other').setStyle(ButtonStyle.Success)
          );
          await msg.edit({ embeds: [ buildPage1EmbedText() ], components: [row1, row2] });
        }
      } catch (err) { console.warn('Failed to edit message after Q1 selection:', err); }

      await interaction.reply({ content: `Selected **${sessions[memberId].q1}** — click Next to continue.`, ephemeral: true });
      return;
    }

    // Next (go to page 2)
    const nextMatch = id.match(/^q1_next_(\d+)$/);
    if (nextMatch) {
      const memberId = nextMatch[1];
      if (interaction.user.id !== memberId) {
        await interaction.reply({ content: 'This Next button is only for the joining member.', ephemeral: true });
        return;
      }
      if (!sessions[memberId] || !sessions[memberId].q1) {
        await interaction.reply({ content: 'Please answer the question first.', ephemeral: true });
        return;
      }

      // edit message to page 2 content (info + Confirm)
      try {
        const ch = interaction.guild.channels.cache.get(sessions[memberId].channelId);
        const msg = ch ? await ch.messages.fetch(sessions[memberId].messageId).catch(()=>null) : null;
        if (msg) {
          const q1Label = sessions[memberId].q1raw || sessions[memberId].q1;
          const embed2 = buildPage2EmbedText(q1Label);
          const confirm = new ButtonBuilder().setCustomId(`q2_confirm_${memberId}`).setLabel('Confirm').setStyle(ButtonStyle.Success);
          const row = new ActionRowBuilder().addComponents(confirm);
          await msg.edit({ embeds: [embed2], components: [row] });
          sessions[memberId].page = 2;
        }
      } catch (err) {
        console.error('Failed to show page 2:', err);
      }

      await interaction.reply({ content: 'Moving to next page...', ephemeral: true });
      return;
    }

    // Confirm (final)
    const confirmMatch = id.match(/^q2_confirm_(\d+)$/);
    if (confirmMatch) {
      const memberId = confirmMatch[1];
      if (interaction.user.id !== memberId) {
        await interaction.reply({ content: 'This Confirm is only for the joining member.', ephemeral: true });
        return;
      }

      // finalize: record, DM, edit final, send chart, assign role
      const q1Label = sessions[memberId] ? (sessions[memberId].q1raw || sessions[memberId].q1) : 'Unknown';

      try {
        // update JSON counts
        const store = readCounts();
        if (!store.choices[q1Label]) store.choices[q1Label] = 0;
        store.choices[q1Label]++;
        writeCounts(store);
      } catch (err) { console.error('Counts update failed:', err); }

      // send super-cool tech DM
      try {
        const dm = new EmbedBuilder()
          .setTitle('Welcome to Cosmos Esports — Mission Accepted 🚀')
          .setDescription(
            `Hey ${interaction.user.username}, welcome aboard!\n\n` +
            'You completed onboarding and your response has been recorded. ' +
            'Expect events, scrims, coaching sessions, and community squads.\n\n' +
            '`> connection established • enjoy the cosmos • ping staff for help`'
          )
          .setColor(0x00ffcc)
          .setFooter({ text: 'Cosmos Esports • Dominate the cosmos' })
          .setTimestamp();
        await interaction.user.send({ embeds: [dm] }).catch(()=>{});
      } catch (err) {
        console.warn('Could not DM user:', err);
      }

      // edit original message to show final thank-you
      try {
        const ch = interaction.guild.channels.cache.get(sessions[memberId].channelId);
        const msg = ch ? await ch.messages.fetch(sessions[memberId].messageId).catch(()=>null) : null;
        if (msg) {
          const done = new EmbedBuilder().setTitle('Thanks!').setDescription(`You selected **${q1Label}** — welcome!`).setColor(0x22bb33);
          await msg.edit({ content: `<@${memberId}>`, embeds: [done], components: [] });
        }
      } catch (err) { console.warn('Failed to edit final message:', err); }

      // send chart to owner
      try {
        const store = readCounts();
        await sendChartToOwner(store.choices, q1Label, interaction.user.tag, interaction.guild);
      } catch (err) { console.error('Chart send failed:', err); }

      // assign role (by name) if exists
      try {
        if (WELCOME_ROLE_NAME) {
          const guildMember = await interaction.guild.members.fetch(memberId).catch(()=>null);
          if (guildMember) {
            const role = interaction.guild.roles.cache.find(r => r.name === WELCOME_ROLE_NAME);
            if (role) await guildMember.roles.add(role).catch(err => console.warn('Role add failed:', err));
            else console.warn('Role not found:', WELCOME_ROLE_NAME);
          }
        }
      } catch (err) { console.warn('Role assignment error:', err); }

      // cleanup session
      setTimeout(()=>{ delete sessions[memberId]; }, 5*60*1000);

      // reply ephemeral to clicking user
      try { if (!interaction.replied) await interaction.reply({ content: 'Onboarding complete — welcome!', ephemeral: true }); } catch {}

      return;
    }

  } catch (err) {
    console.error('InteractionCreate error:', err);
    try { if (!interaction.replied) await interaction.reply({ content: 'Error handling action.', ephemeral: true }); } catch {}
  }
});

// ---------------- Test & simple commands ----------------
client.on(Events.MessageCreate, async (message) => {
  if (message.author.bot) return;
  const c = message.content.trim().toLowerCase();
  if (c === '!ping') {
    try { await message.reply('Pong!'); } catch {}
  }
  if (c === '!status') {
    try { await message.reply(`Bot: ${client.user ? client.user.tag : 'not ready'}, Guilds: ${client.guilds.cache.size}`); } catch {}
  }
  if (c === '!testwelcome') {
    if (!message.guild) { message.reply('Use this inside a server channel.'); return; }
    try {
      const fake = { id: message.author.id, user: message.author, member: message.member, guild: message.guild };
      const res = await startWelcomeTest(fake);
      if (!res.ok) message.reply('Test welcome failed (check logs).'); else message.reply('Test welcome sent to the welcome channel.');
    } catch (err) {
      console.error('!testwelcome error:', err);
      try { message.reply('Test welcome failed (see logs).'); } catch {}
    }
  }
});

// helper wrapper to reuse start logic naming
async function startWelcomeTest(memberLike) { return await startWelcomeFor(memberLike); }

// ---------------- Login ----------------
if (!TOKEN) {
  console.error('Missing TOKEN environment variable. Set TOKEN and redeploy.');
} else {
  client.login(TOKEN).catch(err => console.error('Login failed:', err));
}




