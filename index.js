const express = require("express");
const axios = require("axios");
const sharp = require("sharp");
const { S3Client, PutObjectCommand } = require("@aws-sdk/client-s3");
const app = express();
app.use(express.static("public"));
app.use(express.json());
require("dotenv").config({ path: ".env.local" });
//require("dotenv").config();

app.set("view engine", "ejs");
app.set("views", __dirname + "/views");

// Переменные окружения и URL для S3
const FIGMA_TOKEN = process.env.FIGMA_TOKEN;
const FILE_KEY = process.env.FILE_KEY;
const BUCKET_NAME = process.env.BUCKET_NAME;
const SECRET_KEY = process.env.SECRET_KEY;
const ACCESS_KEY = process.env.ACCESS_KEY;
const ENDPOINT_URL = "https://storage.yandexcloud.net";

// Конфигурация клиента S3 с использованием AWS SDK v3
const s3Client = new S3Client({
	endpoint: ENDPOINT_URL,
	credentials: {
		accessKeyId: ACCESS_KEY,
		secretAccessKey: SECRET_KEY,
	},
	forcePathStyle: true,
	region: "ru-central1",
	signatureVersion: "v4",
});

// Функция для отображения изображений из бакета
const { ListObjectsCommand } = require("@aws-sdk/client-s3");

// Функция для загрузки и сохранения изображений с фреймов
async function downloadAndSaveFrameImages(frames, pageName) {
	const frameIds = frames.map((frame) => frame.id).join(",");
	const imagesUrl = `https://api.figma.com/v1/images/${FILE_KEY}`;
	const headers = {
		"X-Figma-Token": FIGMA_TOKEN,
	};
	const params = {
		ids: frameIds,
		scale: 1,
	};

	try {
		const imagesResponse = await axios.get(imagesUrl, { headers, params });
		const imagesData = imagesResponse.data;

		if (!imagesData.images) {
			console.error("Ключ 'images' отсутствует в данных изображения");
			console.error(imagesData);
			return;
		}

		for (const frame of frames) {
			const frameName = frame.name.replace(/\//g, "-");
			const imageUrl = imagesData.images[frame.id];

			if (!imageUrl) {
				console.warn(`Не удалось найти URL для фрейма ${frameName}`);
				continue;
			}

			try {
				// Скачивание изображения
				const imageResponse = await axios.get(imageUrl, {
					responseType: "arraybuffer",
				});
				const imageBuffer = Buffer.from(imageResponse.data, "binary");

				// Подготовка и отправка команды для загрузки изображения в S3
				const s3Params = {
					Bucket: BUCKET_NAME,
					Key: `${pageName}/${frameName}.png`,
					Body: imageBuffer,
					ContentType: "image/png",
				};

				const command = new PutObjectCommand(s3Params);
				await s3Client.send(command);

				console.log(
					`Изображение ${frameName}.png успешно загружено в папку ${pageName}`,
				);
			} catch (error) {
				console.error(`Ошибка при загрузке изображения ${frameName}:`, error);
			}
		}
	} catch (error) {
		console.error("Ошибка при загрузке изображений:", error);
	}
}

// Пример маршрута для обработки запросов к главной странице
// Обработчик для обновления изображений
app.post("/update-image", async (req, res) => {
	try {
		const { folder } = req.body; // Получаем выбранную папку из запроса
		const fileData = await getFigmaFileData(); // Загрузка данных из Figma
		const pages = fileData.document.children;

		for (const page of pages) {
			// Проверка, содержит ли название страницы emoji
			const hasEmoji = /(\p{Emoji}|[\u203C-\u3299\u200D])/u.test(page.name);

			if (hasEmoji) {
				console.log(`Пропущена страница "${page.name}" из-за наличия emoji`);
				continue; // Пропускаем страницу, если она содержит эмодзи
			}

			// Пропускаем страницы, не соответствующие выбранной папке
			if (folder && page.name !== folder) {
				continue;
			}

			const frames = page.children;
			await downloadAndSaveFrameImages(frames, page.name); // Обновляем только изображения из выбранной папки
		}

		res.send(
			`Изображения успешно загружены для папки: ${folder || "Все страницы"}!`,
		);
	} catch (error) {
		console.error("Ошибка при обновлении изображений:", error);
		res.status(500).send("Произошла ошибка при обработке запроса.");
	}
});

app.get("/folders", async (req, res) => {
	try {
		const command = new ListObjectsCommand({
			Bucket: BUCKET_NAME,
			Delimiter: "/", // Используем Delimiter для получения только папок
		});
		const data = await s3Client.send(command);

		const folders = data.CommonPrefixes.map((prefix) =>
			prefix.Prefix.slice(0, -1),
		); // Удаляем завершающий "/"
		res.json(folders);
	} catch (error) {
		console.error("Ошибка при получении списка папок:", error);
		res.status(500).send("Не удалось получить папки из бакета.");
	}
});

app.get("/images", async (req, res) => {
	try {
		const command = new ListObjectsCommand({
			Bucket: BUCKET_NAME,
		});
		const data = await s3Client.send(command);

		const groupedImages = {};

		data.Contents.forEach((item) => {
			const folder = item.Key.split("/")[0]; // Получаем имя папки
			const imageUrl = `${ENDPOINT_URL}/${BUCKET_NAME}/${item.Key}`;

			if (!groupedImages[folder]) {
				groupedImages[folder] = [];
			}
			groupedImages[folder].push(imageUrl);
		});

		res.json(groupedImages);
	} catch (error) {
		console.error("Ошибка при получении изображений:", error);
		res.status(500).send("Не удалось получить изображения из бакета.");
	}
});

app.get("/", async (req, res) => {
	try {
		// Получаем список папок
		const command = new ListObjectsCommand({
			Bucket: BUCKET_NAME,
			Delimiter: "/", // Получаем только папки
		});
		const data = await s3Client.send(command);

		const folders = data.CommonPrefixes.map((prefix) =>
			prefix.Prefix.slice(0, -1),
		); // Убираем завершающий "/"

		// Рендерим шаблон с папками
		res.render("index", { folders });
	} catch (error) {
		console.error("Ошибка при рендеринге главной страницы:", error);
		res.status(500).send("Ошибка при загрузке главной страницы.");
	}
});

// Функция для получения данных из Figma (пример)
async function getFigmaFileData() {
	const url = `https://api.figma.com/v1/files/${FILE_KEY}`;
	const headers = {
		"X-Figma-Token": FIGMA_TOKEN,
	};

	const response = await axios.get(url, { headers });
	return response.data;
}

// Настройка и запуск сервера (например, с использованием Express)
const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
	console.log(`Сервер запущен на порту ${PORT}`);
});
