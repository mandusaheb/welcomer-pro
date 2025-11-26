// index.js - Fully updated welcome bot
// - Safe env loading
// - Robust welcome flow (image, continue -> animation -> 3 choices)
// - Only the joining member can press Continue/choices (others get ephemeral reply)
// - Professional chart generation and sent as attachment to owner (fallback to channel)
// - Includes !ping, !status, !testwelcome for debugging/testing

// Load env (Railway-safe)
try {
  require('dotenv').config();
} catch (e) {
  // dotenv optional on platforms like Railway
}

// Imports
const fs = require('fs');
const path = require('path');
const Jimp = require('jimp');
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
  AttachmentBuilder
} = require('discord.js');

// Environment variables (no defaults for security)
const TOKEN = process.env.TOKEN;
const WELCOME_CHANNEL_ID = process.env.WELCOME_CHANNEL_ID;
const OWNER_ID = process.env.OWNER_ID;

console.log('TOKEN Loaded:', !!TOKEN);
console.log('WELCOME_CHANNEL_ID Loaded:', !!WELCOME_CHANNEL_ID);
console.log('OWNER_ID Loaded:', !!OWNER_ID);

// Local assets & storage
const LOCAL_BG_PATH = '/mnt/data/brave_screenshot_github.com.png'; // your uploaded image path
const REMOTE_FALLBACK_BG = 'https://i.imgur.com/8Km9tLL.png'; // fallback public image
const STORAGE_FILE = path.join(__dirname, 'engagement_counts.json');

// Ensure storage file exists
if (!fs.existsSync(STORAGE_FILE)) {
  fs.writeFileSync(
    STORAGE_FILE,
    JSON.stringify({ choices: { 'Discord Search': 0, 'Friend Invite': 0, 'Social Media': 0 } }, null, 2)
  );
}

// Helpers for counts
function readCounts() {
  return JSON.parse(fs.readFileSync(STORAGE_FILE, 'utf8'));
}
function writeCounts(data) {
  fs.writeFileSync(STORAGE_FILE, JSON.stringify(data, null, 2));
}

// Create client
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

// Ready log
client.once(Events.ClientReady, () => {
  console.log(`Logged in as ${client.user.tag} (id: ${client.user.id})`);
});

// ========== Image builder ==========
// Build a polished welcome image: blurred bg, rounded card, avatar, title, subtitle, footer
async function makeWelcomeImage(memberLike) {
  // memberLike must have .user (username, displayAvatarURL) and .member (displayName) optionally
  let bg;
  try {
    if (fs.existsSync(LOCAL_BG_PATH)) {
      console.log('Using local background image:', LOCAL_BG_PATH);
      bg = await Jimp.read(LOCAL_BG_PATH);
    } else {
      console.warn('Local background missing; fetching remote fallback:', REMOTE_FALLBACK_BG);
      const res = await fetch(REMOTE_FALLBACK_BG);
      const buffer = await res.buffer();
      bg = await Jimp.read(buffer);
    }
  } catch (err) {
    console.error('Failed to load background image; using solid fallback:', err);
    bg = new Jimp(1200, 675, 0x0a0a0aFF); // dark fallback
  }

  const width = 1200;
  const height = 675;
  bg.cover(width, height);

  const blurred = bg.clone().blur(10).brightness(-0.07);

  const cardW = 980;
  const cardH = 360;
  const cardX = Math.floor((width - cardW) / 2);
  const cardY = Math.floor((height - cardH) / 2);

  // Create card and border
  const card = new Jimp(cardW, cardH, 0x0e0e0eff);
  const border = new Jimp(cardW + 8, cardH + 8, 0x1f6febff);

  // Composite border then card
  blurred.composite(border, cardX - 4, cardY - 4);
  blurred.composite(card, cardX, cardY);

  // Avatar handling
  try {
    const avatarUrl = memberLike.user.displayAvatarURL({ format: 'png', size: 256 });
    const avatarImg = await Jimp.read(avatarUrl);
    avatarImg.cover(160, 160);

    // circular mask for avatar
    const avatarMask = new Jimp(160, 160, 0x00000000);
    avatarMask.scan(0, 0, 160, 160, function (x, y, idx) {
      const cx = 80, cy = 80;
      const dist = Math.sqrt((x - cx) * (x - cx) + (y - cy) * (y - cy));
      avatarMask.bitmap.data[idx + 3] = dist <= 78 ? 255 : 0;
    });

    const avaX = cardX + 30;
    const avaY = cardY + Math.floor((cardH - 160) / 2);
    const avaBg = new Jimp(176, 176, 0x0a1117FF);
    blurred.composite(avaBg, avaX - 8, avaY - 8);
    avatarImg.mask(avatarMask, 0, 0);
    blurred.composite(avatarImg, avaX, avaY);
  } catch (err) {
    console.warn('Could not load user avatar; continuing without avatar:', err);
  }

  // Fonts & text
  try {
    const fontTitle = await Jimp.loadFont(Jimp.FONT_SANS_64_WHITE);
    const fontSub = await Jimp.loadFont(Jimp.FONT_SANS_32_WHITE);
    const fontSmall = await Jimp.loadFont(Jimp.FONT_SANS_16_WHITE);

    const textStartX = cardX + 220;
    const titleY = cardY + 40;
    const subY = cardY + 120;
    const footerY = cardY + cardH - 40;

    // Title (no emoji)
    const titleText = 'Cosmic Gate';
    blurred.print(fontTitle, textStartX, titleY, titleText);

    // Use displayName if available
    const displayName =
      memberLike.member && memberLike.member.displayName
        ? memberLike.member.displayName
        : memberLike.user && memberLike.user.username
        ? memberLike.user.username
        : `User`;

    const subtitle = `Welcome, ${displayName}! A watcher of the stars greets you.`;
    blurred.print(fontSub, textStartX, subY, { text: subtitle, alignmentX: Jimp.HORIZONTAL_ALIGN_LEFT }, cardW - 260);
    blurred.print(fontSmall, textStartX, footerY, 'The stars remember your arrival');
  } catch (err) {
    console.warn('Font load/print failed, continuing without text:', err);
  }

  const outPath = path.join(__dirname, `welcome_${Date.now()}.png`);
  await blurred.quality(90).writeAsync(outPath);
  return outPath;
}

// Animation and chart helpers
const ANIMATION_GIF_URL = 'https://media.giphy.com/media/3o7aCSPqXE5C6T8tBC/giphy.gif';

// Generate a professional chart image buffer using QuickChart and return buffer
async function buildChartBuffer(countsObj, lastChoiceLabel, whoTag) {
  const labels = Object.keys(countsObj);
  const data = labels.map((l) => countsObj[l]);

  const chartConfig = {
    type: 'bar',
    data: {
      labels,
      datasets: [
        {
          label: 'New members',
          data,
          backgroundColor: ['rgba(54,162,235,0.95)', 'rgba(75,192,192,0.95)', 'rgba(153,102,255,0.95)'],
          borderRadius: 8,
          barPercentage: 0.6
        }
      ]
    },
    options: {
      layout: { padding: 12 },
      plugins: {
        title: { display: true, text: 'Where members discover the server', font: { size: 18 } },
        subtitle: { display: true, text: `Last: ${lastChoiceLabel} — by ${whoTag}`, font: { size: 12 } },
        legend: { display: false }
      },
      scales: {
        x: { grid: { display: false }, ticks: { color: '#ffffff' } },
        y: { beginAtZero: true, grid: { color: 'rgba(255,255,255,0.06)' }, ticks: { color: '#ffffff', stepSize: 1 } }
      },
      backgroundColor: '#0b0b0d'
    }
  };

  const qcUrl = `https://quickchart.io/chart?c=${encodeURIComponent(JSON.stringify(chartConfig))}&w=1000&h=550&format=png&version=3`;

  const res = await fetch(qcUrl);
  if (!res.ok) throw new Error(`Chart fetch failed: ${res.status}`);
  const buffer = await res.buffer();
  return buffer;
}

// Send professional chart to owner (attachment). Fallback to posting in the welcome channel.
async function makeProfessionalChartAndSend(countsObj, lastChoiceLabel, whoTag, guild) {
  try {
    const buffer = await buildChartBuffer(countsObj, lastChoiceLabel, whoTag);
    const attachment = new AttachmentBuilder(buffer, { name: 'engagement_chart.png' });

    // Try DM owner
    try {
      const owner = await client.users.fetch(OWNER_ID);
      if (owner) {
        await owner.send({ content: `New choice recorded: **${lastChoiceLabel}** (by ${whoTag})`, files: [attachment] });
        return;
      }
    } catch (err) {
      console.warn('Could not DM owner; will fallback to channel.', err);
    }

    // fallback to posting in guild channel
    try {
      const ch = guild.channels.cache.get(WELCOME_CHANNEL_ID);
      if (ch) {
        await ch.send({ content: `Latest engagement chart:`, files: [attachment] });
      }
    } catch (err) {
      console.error('Failed to post chart to welcome channel:', err);
    }
  } catch (err) {
    console.error('makeProfessionalChartAndSend error:', err);
  }
}

// Shared welcome flow (used by member join and !testwelcome)
async function runWelcomeFlowFor(memberLike) {
  try {
    const channel = memberLike.guild.channels.cache.get(WELCOME_CHANNEL_ID);
    if (!channel) {
      console.error('Welcome channel not found or bot missing permission. WELCOME_CHANNEL_ID:', WELCOME_CHANNEL_ID);
      return { ok: false, reason: 'invalid_channel' };
    }

    const imagePath = await makeWelcomeImage(memberLike);
    const continueBtn = new ButtonBuilder().setCustomId(`welcome_continue_${memberLike.id}_${Date.now()}`).setLabel('Continue').setStyle(ButtonStyle.Primary);
    const row = new ActionRowBuilder().addComponents(continueBtn);

    await channel.send({ content: `<@${memberLike.id}>`, files: [imagePath], components: [row] });

    // cleanup
    setTimeout(() => {
      try { fs.unlinkSync(imagePath); } catch (e) {}
    }, 60_000);

    return { ok: true };
  } catch (err) {
    console.error('runWelcomeFlowFor error:', err);
    return { ok: false, reason: 'error', error: err };
  }
}

// On new member join
client.on(Events.GuildMemberAdd, async (member) => {
  console.log('GuildMemberAdd fired for:', member.user.tag, member.id);
  const res = await runWelcomeFlowFor(member);
  if (!res.ok) console.warn('Welcome flow failed for new member:', res);
});

// Interaction handler (robust extraction + ephemeral replies)
client.on(Events.InteractionCreate, async (interaction) => {
  try {
    if (!interaction.isButton()) return;

    const id = interaction.customId;

    // Continue button
    const continueMatch = id.match(/^welcome_continue_(\d+)_\d+$/);
    if (continueMatch) {
      const targetMemberId = continueMatch[1];

      if (interaction.user.id !== targetMemberId) {
        await interaction.reply({ content: "This Continue button is only for the new member — you can't use it.", ephemeral: true });
        return;
      }

      // update to animation
      await interaction.update({
        content: `<@${targetMemberId}>`,
        embeds: [ new EmbedBuilder().setTitle('✨ A cosmic greeting...').setDescription('Preparing the stars...').setImage(ANIMATION_GIF_URL) ],
        components: []
      });

      // after delay show options
      setTimeout(async () => {
        const row = new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId(`choice_${targetMemberId}_Discord Search`).setLabel('Discord Search').setStyle(ButtonStyle.Secondary),
          new ButtonBuilder().setCustomId(`choice_${targetMemberId}_Friend Invite`).setLabel('Friend Invite').setStyle(ButtonStyle.Success),
          new ButtonBuilder().setCustomId(`choice_${targetMemberId}_Social Media`).setLabel('Social Media').setStyle(ButtonStyle.Primary)
        );

        try {
          await interaction.message.edit({
            content: `<@${targetMemberId}>`,
            embeds: [ new EmbedBuilder().setTitle('Tell us how you found us').setDescription('Choose one option below:') ],
            components: [ row ]
          });
        } catch (err) {
          try {
            await interaction.followUp({
              content: `<@${targetMemberId}>`,
              embeds: [ new EmbedBuilder().setTitle('Tell us how you found us').setDescription('Choose one option below:') ],
              components: [ row ]
            });
          } catch (err2) {
            console.error('Failed to present choices:', err2);
          }
        }
      }, 2200);

      return;
    }

    // Choice buttons
    const choiceMatch = id.match(/^choice_(\d+)_(.+)$/);
    if (choiceMatch) {
      const memberId = choiceMatch[1];
      const chosenLabel = choiceMatch[2];

      if (interaction.user.id !== memberId) {
        await interaction.reply({ content: "This choice isn't for you.", ephemeral: true });
        return;
      }

      // update counts
      const store = readCounts();
      if (!store.choices[chosenLabel]) store.choices[chosenLabel] = 0;
      store.choices[chosenLabel]++;
      writeCounts(store);

      // ack user
      await interaction.update({
        content: `<@${memberId}>`,
        embeds: [ new EmbedBuilder().setTitle('Thanks!').setDescription(`You chose: **${chosenLabel}**`) ],
        components: []
      });

      // send chart to owner (attachment)
      try {
        await makeProfessionalChartAndSend(store.choices, chosenLabel, interaction.user.tag, interaction.guild);
      } catch (err) {
        console.error('Failed to generate/send chart:', err);
      }

      return;
    }
  } catch (err) {
    console.error('InteractionCreate handler error:', err);
    try { if (!interaction.replied && !interaction.deferred) await interaction.reply({ content: 'There was an error handling your interaction.', ephemeral: true }); } catch {}
  }
});

// Message commands: !ping, !status, !testwelcome
client.on(Events.MessageCreate, async (message) => {
  if (message.author.bot) return;
  const content = message.content.trim().toLowerCase();

  if (content === '!ping') {
    try { await message.reply('Pong!'); } catch (err) { console.error('!ping reply failed:', err); }
    return;
  }

  if (content === '!status') {
    try { await message.reply(`Bot: ${client.user ? client.user.tag : 'not ready'}, Guilds: ${client.guilds.cache.size}`); } catch (err) { console.error('!status reply failed:', err); }
    return;
  }

  if (content === '!testwelcome') {
    if (!message.guild) {
      message.reply('This command must be used in a server channel.');
      return;
    }
    try {
      console.log('!testwelcome invoked by', message.author.tag);
      const fakeMember = { id: message.author.id, user: message.author, member: message.member, guild: message.guild };
      const res = await runWelcomeFlowFor(fakeMember);
      if (!res.ok) message.reply('Test welcome failed (check logs).');
      else message.reply('Test welcome sent to the configured welcome channel.');
    } catch (err) {
      console.error('!testwelcome failed:', err);
      try { message.reply('Test welcome encountered an error (see logs).'); } catch {}
    }
    return;
  }
});

// Login
if (!TOKEN) {
  console.error('Missing TOKEN environment variable. Set TOKEN in Railway variables and redeploy.');
} else {
  client.login(TOKEN).catch((err) => {
    console.error('Bot login failed. Check TOKEN in Railway → Variables.', err);
  });
}



