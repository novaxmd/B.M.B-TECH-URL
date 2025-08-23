import formidable from "formidable";
import fs from "fs";
import path from "path";

export const config = {
  api: {
    bodyParser: false
  }
};

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const form = new formidable.IncomingForm();
  form.uploadDir = "/tmp"; // Vercel serverless temp folder
  form.keepExtensions = true;

  form.parse(req, async (err, fields, files) => {
    if (err) return res.status(500).json({ error: "File parse error" });

    const file = files.file; // 'file' ni name ya form field
    if (!file) return res.status(400).json({ error: "No file uploaded" });

    // Vercel serverless uses /tmp as temporary folder
    const fileUrl = `https://${req.headers.host}/api/files/${path.basename(file.filepath)}`;

    // Return JSON with URL
    res.status(200).json({ url: fileUrl });
  });
        }
