// Processor operations for images, PDFs and documents, keyed by name. Each takes plain arguments (file bytes
// arrive as Uint8Arrays) and returns plain results. `limits` always comes from the main process (LIMITS).
import * as image from './image.js';
import * as pdf from './pdf.js';
import * as docx from './docx.js';
import * as photo from './photo.js';
import * as pdfTools from './pdf-tools.js';
import * as pdfEdit from './pdf-edit.js';
import * as imageText from './image-text.js';
import * as docxEdit from './docx-edit.js';
import * as audio from './audio.js';
import * as any from './anyfile.js';
import * as table from './table.js';

export const OPS = {
  'image.info': image.info,
  'image.frames': image.frames,
  'table.fromCsv': table.fromCsv,
  'table.convert': table.convert,
  'image.convert': image.convert,
  'image.animate': image.animate,
  'image.preview': image.preview,
  'image.toPdf': pdf.imagesToPdf,
  'image.toDocx': async ({ bytes, quality, limits, paper }) => {
    const { canvas } = await image.decode(bytes, limits);
    const alpha = image.hasAlpha(canvas);
    const picture = { bytes: await image.encode(canvas, alpha ? 'png' : 'jpg', quality), ext: alpha ? 'png' : 'jpeg', width: canvas.width, height: canvas.height };
    return docx.fromPicture({ picture, paper });
  },
  'qr.read': image.readQR,
  'photo.adjust': photo.adjust,
  'photo.rotate': photo.rotate,
  'photo.crop': photo.crop,
  'photo.backdrop': photo.backdrop,
  'photo.resize': photo.resize,
  'photo.redact': photo.redact,
  'photo.collage': photo.collage,
  'pdf.fromImages': pdf.fromImages,
  'pdf.info': pdf.info,
  'pdf.render': pdf.render,
  'pdf.text': pdf.text,
  'pdf.toDocx': async ({ bytes, limits, paper }) => docx.fromParagraphs({ pages: await pdf.paragraphsOf({ bytes, limits }), paper }),
  'pdf.layout': pdfTools.layout,
  'pdf.merge': pdfTools.merge,
  'pdf.split': pdfTools.split,
  'pdf.arrange': pdfTools.arrange,
  'pdf.shrink': pdfTools.shrink,
  'pdf.tidySize': pdfTools.tidySize,
  'pdf.numbers': pdfTools.numbers,
  'pdf.watermark': pdfTools.watermark,
  'pdf.editScan': pdfEdit.scan,
  'pdf.editPreview': pdfEdit.preview,
  'pdf.editSave': pdfEdit.save,
  'imageText.scan': imageText.scan,
  'imageText.preview': imageText.preview,
  'imageText.save': imageText.save,
  'audio.look': audio.look,
  'shrink.image': any.shrinkImage,
  'meta.image': any.imageMeta,
  'meta.imageClean': any.imageClean,
  'meta.pdf': any.pdfMeta,
  'meta.pdfClean': any.pdfClean,
  'docx.read': docx.read,
  'docx.fromText': docx.fromText,
  'docx.fromMarkdown': docx.fromMarkdown,
  'docx.editScan': docxEdit.scan,
  'docx.editSave': docxEdit.save,
};
