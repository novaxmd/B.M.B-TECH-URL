import formidable from "formidable";
import fs from "fs";

export const config = {
  api: {
    bodyParser: false
  }
};

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const form = new formidable.IncomingForm();
  form.keepExtensions = true;

  form.parse(req, (err, fields, files) => {
    if (err) return res.status(500).json({ error: "File parse error" });

    const file = files.file;
    if (!file) return res.status(400).json({ error: "No file uploaded" });

    // Read file as base64 for temporary test
    const data = fs.readFileSync(file.filepath);
    const base64 = `data:${file.mimetype};base64,${data.toString('base64')}`;

    // Respond with file info
    res.status(200).json({
      url: base64,
      name: file.originalFilename,
      type: file.mimetype,
      size: file.size
    });
  });
      }
