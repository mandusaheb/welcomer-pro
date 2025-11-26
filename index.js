// index.js - debug-ready welcome bot
// Paste this entire file, commit & redeploy

// Load environment variables (Railway-safe)
try {
  require('dotenv').config();
} catch (e) {
  // dotenv optional on Railway
}

// Modules
const fs = require('fs');
const path = require('path');
const Jimp = require('jimp');
const fetch = require('node-fetch'); // ensure node-fetch v2 in package.json/deps
const {
  Client,
  GatewayIntentBits,
  Partials,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  Events
} = require('discord.js');

// Environment variables (NO defaults here for security)
const TOKEN = process.env.TOKEN;
const WELCOME_CHANNEL_ID = process.env.WELCOME_CHANNEL_ID;
const OWNER_ID = process.env.OWNER_ID;

console.log('TOKEN Loaded:', !!TOKEN);
console.log('WELCOME_CHANNEL_ID Loaded:', !!WELCOME_CHANNEL_ID);
console.log('OWNER_ID Loaded:', !!OWNER_ID);

// Paths & storage
const LOCAL_BG_PATH = '/mnt/data/brave_screenshot_github.com.png'; // local upload path
const REMOTE_FALLBACK_BG = 'https://i.imgur.com/8Km9tLL.png'; // small public fallback (replace if you want)
const STORAGE_FILE = path.join(__dirname, 'engagement_counts.json');

// Ensure storage file exists
if (!fs.existsSync(STORAGE_FILE)) {
  fs.writeFileSync(
    STORAGE_FILE,
    JSON.stringify(
      {
        choices: {
          'Discord Search': 0,
          'Friend Invite': 0,
          'Social Media': 0
        }
      },
      null,
      2
    )
  );
}

// Helpers to read/write counts
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

// Ready handler
client.once(Events.ClientReady, () => {
  console.log(`Logged in as ${client.user.tag} (id: ${client.user.id})`);
});

// Build welcome image (tries local, falls back to remote, and never crashes)
async function makeWelcomeImage(memberTag) {
  let bg;
  try {
    if (fs.existsSync(LOCAL_BG_PATH)) {
      console.log('Using local background image:', LOCAL_BG_PATH);
      bg = await Jimp.read(LOCAL_BG_PATH);
    } else {
      console.warn('Local background missing, using remote fallback:', REMOTE_FALLBACK_BG);
      const res = await fetch(REMOTE_FALLBACK_BG);
      const buffer = await res.buffer();
      bg = await Jimp.read(buffer);
    }
  } catch (err) {
    console.error('Failed to load background image (will create solid bg):', err);
    bg = new Jimp(1200, 675, 0x0a0a0aFF); // fallback solid dark bg
  }

  // Prepare sizes and effects
  bg.cover(1200, 675);
  const blurred = bg.clone().blur(12).brightness(-0.05);

  // Create semi-transparent card
  const card = new Jimp(1000, 400, 0x00000088);

  // Compose card centered
  const x = Math.floor((blurred.bitmap.width - card.bitmap.width) / 2);
  const y = Math.floor((blurred.bitmap.height - card.bitmap.height) / 2);
  blurred.composite(card, x, y);

  // Print text (fonts may fail in very restricted environments; we catch errors)
  try {
    const fontTitle = await Jimp.loadFont(Jimp.FONT_SANS_64_WHITE);
    const fontSub = await Jimp.loadFont(Jimp.FONT_SANS_32_WHITE);
    const fontSmall = await Jimp.loadFont(Jimp.FONT_SANS_16_WHITE);

    blurred.print(fontTitle, x + 30, y + 30, '🌌 Cosmic Gate');
    blurred.print(fontSub, x + 30, y + 120, `Welcome, ${memberTag}! A watcher of the stars greets you.`);
    blurred.print(fontSmall, x + 30, y + 360, 'The stars remember your arrival');
  } catch (err) {
    console.warn('Failed to load/print fonts in Jimp (continuing):', err);
  }

  const outPath = path.join(__dirname, `welcome_${Date.now()}.png`);
  await blurred.quality(90).writeAsync(outPath);
  return outPath;
}

// Animation and chart helpers
const ANIMATION_GIF_URL = 'https://media.giphy.com/media/3o7aCSPqXE5C6T8tBC/giphy.gif';
function makeChartUrl(countsObj) {
  const labels = Object.keys(countsObj);
  const data = labels.map((l) => countsObj[l]);
  const chartConfig = {
    type: 'bar',
    data: { labels, datasets: [{ label: 'Engagement sources', data }] },
    options: { plugins: { legend: { display: false } } }
  };
  return `https://quickchart.io/chart?c=${encodeURIComponent(JSON.stringify(chartConfig))}&w=800&h=450&format=png`;
}

// Shared welcome flow implementation (used by GuildMemberAdd and !testwelcome)
async function runWelcomeFlowFor(memberLike) {
  // memberLike must have: id, user { username, discriminator, tag }, guild
  try {
    const channel = memberLike.guild.channels.cache.get(WELCOME_CHANNEL_ID);
    if (!channel) {
      console.error('Welcome channel not found or bot missing permission. WELCOME_CHANNEL_ID:', WELCOME_CHANNEL_ID);
      return { ok: false, reason: 'invalid_channel' };
    }

    const memberTag = memberLike.user ? `${memberLike.user.username}#${memberLike.user.discriminator}` : `User#${memberLike.id}`;
    const imagePath = await makeWelcomeImage(memberTag);

    const continueBtn = new ButtonBuilder()
      .setCustomId(`welcome_continue_${memberLike.id}_${Date.now()}`)
      .setLabel('Continue')
      .setStyle(ButtonStyle.Primary);

    const row = new ActionRowBuilder().addComponents(continueBtn);

    await channel.send({ content: `<@${memberLike.id}>`, files: [imagePath], components: [row] });

    // cleanup after a bit
    setTimeout(() => {
      try {
        fs.unlinkSync(imagePath);
      } catch (e) {}
    }, 60_000);

    return { ok: true };
  } catch (err) {
    console.error('runWelcomeFlowFor error:', err);
    return { ok: false, reason: 'error', error: err };
  }
}

// Event: new guild member
client.on(Events.GuildMemberAdd, async (member) => {
  console.log('GuildMemberAdd fired for:', member.user.tag, member.id);
  const res = await runWelcomeFlowFor(member);
  if (!res.ok) console.warn('Welcome flow failed for new member:', res);
});

// Interaction handling (buttons)
client.on(Events.InteractionCreate, async (interaction) => {
  try {
    if (!interaction.isButton()) return;

    const id = interaction.customId;

    // Continue pressed
    if (id.startsWith('welcome_continue_')) {
      const parts = id.split('_');
      const targetMemberId = parts[2];
      if (interaction.user.id !== targetMemberId) {
        await interaction.reply({ content: 'This is not for you.', ephemeral: true });
        return;
      }

      await interaction.update({
        content: `<@${targetMemberId}>`,
        embeds: [
          new EmbedBuilder()
            .setTitle('✨ A cosmic greeting...')
            .setDescription('Hold on while the stars arrange themselves.')
            .setImage(ANIMATION_GIF_URL)
        ],
        components: []
      });

      // after short delay show options
      setTimeout(async () => {
        const row = new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId(`choice_${targetMemberId}_Discord Search`).setLabel('Discord Search').setStyle(ButtonStyle.Secondary),
          new ButtonBuilder().setCustomId(`choice_${targetMemberId}_Friend Invite`).setLabel('Friend Invite').setStyle(ButtonStyle.Success),
          new ButtonBuilder().setCustomId(`choice_${targetMemberId}_Social Media`).setLabel('Social Media').setStyle(ButtonStyle.Primary)
        );

        try {
          await interaction.message.edit({
            content: `<@${targetMemberId}>`,
            embeds: [new EmbedBuilder().setTitle('Tell us how you found us').setDescription('Choose one option below:')],
            components: [row]
          });
        } catch (err) {
          // fallback to followUp if editing fails
          try {
            await interaction.followUp({
              content: `<@${targetMemberId}>`,
              embeds: [new EmbedBuilder().setTitle('Tell us how you found us').setDescription('Choose one option below:')],
              components: [row]
            });
          } catch (err2) {
            console.error('Failed to present choices:', err2);
          }
        }
      }, 2200);

      return;
    }

    // Choice pressed
    if (id.startsWith('choice_')) {
      const match = id.match(/^choice_([^_]+)_(.+)$/);
      if (!match) {
        await interaction.reply({ content: 'Invalid payload.', ephemeral: true });
        return;
      }
      const memberId = match[1];
      const chosenLabel = match[2];

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
        embeds: [new EmbedBuilder().setTitle('Thanks!').setDescription(`You chose: **${chosenLabel}**`)],
        components: []
      });

      // send chart to owner (fallback to channel)
      try {
        const chartUrl = makeChartUrl(store.choices);
        const owner = await client.users.fetch(OWNER_ID).catch(() => null);
        if (owner) {
          await owner.send({
            content: `New choice recorded: **${chosenLabel}** from ${interaction.user.tag}`,
            embeds: [new EmbedBuilder().setTitle('Engagement Chart').setImage(chartUrl)]
          }).catch(() => {});
        } else {
          // fallback to posting in welcome channel if owner couldn't be DM'd/fetched
          const ch = interaction.guild.channels.cache.get(WELCOME_CHANNEL_ID);
          if (ch) {
            await ch.send({ content: `Latest engagement chart:`, embeds: [new EmbedBuilder().setTitle('Engagement Chart').setImage(chartUrl)] }).catch(() => {});
          }
        }
      } catch (err) {
        console.error('Error sending chart to owner/channel:', err);
      }

      return;
    }
  } catch (err) {
    console.error('InteractionCreate handler error:', err);
    try {
      if (!interaction.deferred && !interaction.replied) await interaction.reply({ content: 'There was an error handling that action.', ephemeral: true });
    } catch {}
  }
});

// Message commands: !ping, !status, !testwelcome
client.on(Events.MessageCreate, async (message) => {
  if (message.author.bot) return;
  const content = message.content.trim().toLowerCase();

  if (content === '!ping') {
    try {
      await message.reply('Pong!');
    } catch (err) {
      console.error('!ping reply failed:', err);
    }
    return;
  }

  if (content === '!status') {
    try {
      await message.reply(`Bot: ${client.user ? client.user.tag : 'not ready'}, Guilds: ${client.guilds.cache.size}`);
    } catch (err) {
      console.error('!status reply failed:', err);
    }
    return;
  }

  // DEBUG: trigger welcome flow for the command author
  if (content === '!testwelcome') {
    // make sure the author is in a guild (not in DM)
    if (!message.guild) {
      message.reply('This command must be used in a server channel.');
      return;
    }

    try {
      console.log('!testwelcome invoked by', message.author.tag);
      const fakeMember = {
        id: message.author.id,
        user: message.author,
        guild: message.guild
      };
      const res = await runWelcomeFlowFor(fakeMember);
      if (!res.ok) {
        message.reply('Test welcome failed (check logs).');
      } else {
        message.reply('Test welcome sent to the configured welcome channel.');
      }
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




