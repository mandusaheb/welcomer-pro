// index.js
// Discord.js v14 bot that:
// 1) On guildMemberAdd: creates a blurred-background welcome image (from local upload),
//    displays a centered "welcome card" image, sends it with a "Continue" button.
// 2) On Continue -> shows an animation (GIF) page, then shows 3 option buttons.
// 3) Records which option the user picked in a local JSON file.
// 4) Generates and sends an engagement graph (QuickChart) to the bot owner (owner ID).
//
// Requirements:
// npm i discord.js@14 jimp node-fetch@2
//
// Set environment vars: TOKEN, WELCOME_CHANNEL_ID, OWNER_ID (bot owner, receives graph).
//
// The code uses this local uploaded file path as the background image:
//   /mnt/data/brave_screenshot_github.com.png
//
// NOTE: Discord does not allow true UI blur/overlay. We simulate by blurring the background image
// and composing a centered card image server-side using Jimp.

const fs = require('fs');
const path = require('path');
const Jimp = require('jimp');
const fetch = require('node-fetch'); // only for safety if needed later
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

const TOKEN = process.env.TOKEN || 'YOUR_BOT_TOKEN_HERE';
const WELCOME_CHANNEL_ID = process.env.WELCOME_CHANNEL_ID || 'YOUR_CHANNEL_ID_HERE';
const OWNER_ID = process.env.OWNER_ID || 'YOUR_USER_ID_HERE'; // who receives graphs
const LOCAL_BG_PATH = '/mnt/data/brave_screenshot_github.com.png'; // uploaded file path
const STORAGE_FILE = path.join(__dirname, 'engagement_counts.json');

// ensure storage exists
if (!fs.existsSync(STORAGE_FILE)) {
  fs.writeFileSync(STORAGE_FILE, JSON.stringify({
    choices: {
      'Discord Search': 0,
      'Friend Invite': 0,
      'Social Media': 0
    }
  }, null, 2));
}

// helper: read & write counts
function readCounts() {
  return JSON.parse(fs.readFileSync(STORAGE_FILE, 'utf8'));
}
function writeCounts(data) {
  fs.writeFileSync(STORAGE_FILE, JSON.stringify(data, null, 2));
}

// prepare client
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

// Compose a blurred welcome image with Jimp.
// Outputs a temporary file path to send to discord.
async function makeWelcomeImage(memberTag) {
  // Load background (local upload)
  const bg = await Jimp.read(LOCAL_BG_PATH);

  // Resize to friendly Discord image size
  bg.cover(1200, 675); // 16:9 card

  // create blurred background copy
  const blurred = bg.clone().blur(12).brightness(-0.05);

  // create overlay card (semi-transparent rectangle)
  const card = new Jimp(1000, 400, 0x00000088); // semi-transparent black (ARGB)
  // Slightly round corners by a mask
  const mask = new Jimp(card.bitmap.width, card.bitmap.height, 0x00000000);
  mask.scan(0, 0, mask.bitmap.width, mask.bitmap.height, function (x, y, idx) {
    const rx = x - mask.bitmap.width / 2;
    const ry = y - mask.bitmap.height / 2;
    const radius = Math.min(mask.bitmap.width, mask.bitmap.height) / 2;
    // Simple rounded-mask using ellipse equation (soft)
    const inside = Math.sqrt(rx * rx + ry * ry) < radius + 60; // fudge factor
    mask.bitmap.data[idx + 0] = 255;
    mask.bitmap.data[idx + 1] = 255;
    mask.bitmap.data[idx + 2] = 255;
    mask.bitmap.data[idx + 3] = inside ? 255 : 0;
  });

  // Compose onto blurred background centered
  const x = Math.floor((blurred.bitmap.width - card.bitmap.width) / 2);
  const y = Math.floor((blurred.bitmap.height - card.bitmap.height) / 2);
  blurred.composite(card, x, y);

  // load a font and write title + subtitle
  const fontTitle = await Jimp.loadFont(Jimp.FONT_SANS_64_WHITE);
  const fontSub = await Jimp.loadFont(Jimp.FONT_SANS_32_WHITE);

  // Title
  blurred.print(
    fontTitle,
    x + 30,
    y + 30,
    {
      text: '🌌 Cosmic Gate',
      alignmentX: Jimp.HORIZONTAL_ALIGN_LEFT,
      alignmentY: Jimp.VERTICAL_ALIGN_MIDDLE
    },
    card.bitmap.width - 60,
    100
  );

  // Subtitle with mention of member
  blurred.print(
    fontSub,
    x + 30,
    y + 120,
    {
      text: `Welcome, ${memberTag}! A watcher of the stars greets you.`,
      alignmentX: Jimp.HORIZONTAL_ALIGN_LEFT,
      alignmentY: Jimp.VERTICAL_ALIGN_TOP
    },
    card.bitmap.width - 60,
    200
  );

  // small footer text
  const fontSmall = await Jimp.loadFont(Jimp.FONT_SANS_16_WHITE);
  blurred.print(fontSmall, x + 30, y + card.bitmap.height - 40, 'The stars remember your arrival');

  // Save to a temp file
  const outPath = path.join(__dirname, `welcome_${Date.now()}.png`);
  await blurred.quality(90).writeAsync(outPath);
  return outPath;
}

// Create a simple animated card step (we'll just send a GIF or we can create many frames with Jimp — using a GIF URL for simplicity)
const ANIMATION_GIF_URL = 'https://media.giphy.com/media/3o7aCSPqXE5C6T8tBC/giphy.gif'; // cosmic pulse GIF (public)

// Helper: build QuickChart URL for chart image (bar chart of counts)
function makeChartUrl(countsObj) {
  // QuickChart docs: compose a Chart.js config and encode it in a URL
  // We'll make a bar chart with labels and counts
  const labels = Object.keys(countsObj);
  const data = labels.map(l => countsObj[l]);

  const chartConfig = {
    type: 'bar',
    data: {
      labels,
      datasets: [{
        label: 'Engagement sources',
        data,
        backgroundColor: 'rgba(40, 150, 255, 0.8)'
      }]
    },
    options: {
      plugins: {
        legend: { display: false },
        title: {
          display: true,
          text: 'Where new members discover the server'
        }
      }
    }
  };

  const base = 'https://quickchart.io/chart';
  const url = `${base}?c=${encodeURIComponent(JSON.stringify(chartConfig))}&w=800&h=450&format=png`;
  return url;
}

// When a new member joins: create the welcome flow
client.on(Events.GuildMemberAdd, async (member) => {
  try {
    const channel = member.guild.channels.cache.get(WELCOME_CHANNEL_ID);
    if (!channel) {
      console.warn('Welcome channel not found; set WELCOME_CHANNEL_ID.');
      return;
    }

    // 1) Make blurred-centered welcome image
    const welcomeImagePath = await makeWelcomeImage(`${member.user.username}#${member.user.discriminator}`);

    // Buttons: Continue -> plays animation -> options
    const continueBtn = new ButtonBuilder()
      .setCustomId(`welcome_continue_${member.id}_${Date.now()}`)
      .setLabel('Continue')
      .setStyle(ButtonStyle.Primary);

    const row1 = new ActionRowBuilder().addComponents(continueBtn);

    // Send image + button
    const sent = await channel.send({
      content: `<@${member.id}>`,
      files: [welcomeImagePath],
      components: [row1]
    });

    // cleanup local generated image file after a short delay
    setTimeout(() => {
      try { fs.unlinkSync(welcomeImagePath); } catch (e) {}
    }, 60_000);

    // We'll store the message id & member id so only that user can progress the flow
    // (Alternatively check customId for member id)
  } catch (err) {
    console.error('Error in GuildMemberAdd handler:', err);
  }
});

// Interaction handler for buttons
client.on(Events.InteractionCreate, async (interaction) => {
  try {
    if (!interaction.isButton()) return;

    const id = interaction.customId;

    // Step 1: Continue pressed: show animation, then show options
    if (id.startsWith('welcome_continue_')) {
      // Ensure the button is for this member (we embedded member id in the customId)
      const parts = id.split('_'); // ['welcome','continue','<memberId>','<timestamp>']
      const targetMemberId = parts[2];
      if (interaction.user.id !== targetMemberId) {
        await interaction.reply({ content: "This is not for you. Wait for your own welcome message.", ephemeral: true });
        return;
      }

      // Acknowledge and update message with animation GIF
      await interaction.update({
        content: `<@${targetMemberId}>`,
        embeds: [
          new EmbedBuilder()
            .setTitle('✨ A cosmic greeting...')
            .setDescription('Hold on while the stars arrange themselves.')
            .setImage(ANIMATION_GIF_URL)
        ],
        components: [] // remove continue button
      });

      // after short delay, present choices
      setTimeout(async () => {
        // Prepare three options (customizable)
        const choices = [
          { id: 'opt_search', label: 'Discord Search' },
          { id: 'opt_friend', label: 'Friend Invite' },
          { id: 'opt_social', label: 'Social Media' }
        ];

        const row = new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId(`choice_${targetMemberId}_Discord Search`).setLabel('Discord Search').setStyle(ButtonStyle.Secondary),
          new ButtonBuilder().setCustomId(`choice_${targetMemberId}_Friend Invite`).setLabel('Friend Invite').setStyle(ButtonStyle.Success),
          new ButtonBuilder().setCustomId(`choice_${targetMemberId}_Social Media`).setLabel('Social Media').setStyle(ButtonStyle.Primary)
        );

        // Edit the original message (interaction.message)
        try {
          await interaction.message.edit({
            content: `<@${targetMemberId}>`,
            embeds: [
              new EmbedBuilder()
                .setTitle('Tell us how you found us')
                .setDescription('Choose one option below — your answer helps us know what works.')
            ],
            components: [row]
          });
        } catch (e) {
          // If editing fails, attempt to reply instead
          try {
            await interaction.followUp({
              content: `<@${targetMemberId}>`,
              embeds: [
                new EmbedBuilder()
                  .setTitle('Tell us how you found us')
                  .setDescription('Choose one option below — your answer helps us know what works.')
              ],
              components: [row]
            });
          } catch (err) {
            console.error('Failed to present choices:', err);
          }
        }
      }, 2200); // ~2.2s
      return;
    }

    // Step 2: Handle choice button click
    if (id.startsWith('choice_')) {
      // format: choice_<memberId>_<Label with spaces preserved due to our customId design>
      // but we used underscores in split earlier; use split only once.
      // To be safe, use regex to extract memberId and label after prefix `choice_`
      const match = id.match(/^choice_([^_]+)_(.+)$/);
      if (!match) {
        await interaction.reply({ content: 'Invalid choice payload.', ephemeral: true });
        return;
      }
      const targetMemberId = match[1];
      const chosenLabel = match[2];

      if (interaction.user.id !== targetMemberId) {
        await interaction.reply({ content: "This choice isn't for you.", ephemeral: true });
        return;
      }

      // record the choice
      const store = readCounts();
      if (!store.choices[chosenLabel]) store.choices[chosenLabel] = 0;
      store.choices[chosenLabel]++;
      writeCounts(store);

      // Acknowledge to user
      await interaction.update({
        content: `<@${targetMemberId}>`,
        embeds: [
          new EmbedBuilder()
            .setTitle('Thanks!')
            .setDescription(`You chose: **${chosenLabel}** — this helps us a lot.`)
            .setFooter({ text: 'You can always change this later in #welcome' })
        ],
        components: []
      });

      // Send updated chart to owner (or channel) — generate QuickChart URL and DM owner
      try {
        const chartUrl = makeChartUrl(store.choices);
        const owner = await client.users.fetch(OWNER_ID);
        if (owner) {
          await owner.send({
            content: `New choice recorded: **${chosenLabel}** from ${interaction.user.tag}. Latest engagement chart:`,
            embeds: [
              new EmbedBuilder().setTitle('Engagement Chart').setImage(chartUrl)
            ]
          }).catch(err => {
            console.warn('Could not DM owner. Trying to post chart to the welcome channel.');
            // fallback: post chart in welcome channel
            const guild = interaction.guild;
            const channel = guild.channels.cache.get(WELCOME_CHANNEL_ID);
            if (channel) {
              channel.send({
                content: `Owner couldn't be DMed; latest engagement chart:`,
                embeds: [new EmbedBuilder().setTitle('Engagement Chart').setImage(chartUrl)]
              }).catch(e => console.error('Failed fallback posting chart:', e));
            }
          });
        }
      } catch (err) {
        console.error('Error sending chart to owner:', err);
      }

      return;
    }

  } catch (err) {
    console.error('InteractionCreate handler error:', err);
    try {
      if (interaction.deferred || interaction.replied) return;
      await interaction.reply({ content: 'There was an error handling that action.', ephemeral: true });
    } catch (e) {}
  }
});

// simple ping command
client.on(Events.MessageCreate, async (message) => {
  if (message.author.bot) return;
  if (message.content.trim().toLowerCase() === '!ping') {
    const sent = await message.reply('Pong!');
    await message.channel.send(`Latency: ${sent.createdTimestamp - message.createdTimestamp}ms`);
  }
});

// login
client.login(TOKEN).catch(err => {
  console.error('Login failed. Ensure TOKEN is set. Error:', err);
});
