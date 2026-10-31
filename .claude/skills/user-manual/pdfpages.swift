// Renders every page of a PDF to PNG: swift pdfpages.swift <file.pdf> <outdir> [scale]
import AppKit
import PDFKit
let args = CommandLine.arguments
let doc = PDFDocument(url: URL(fileURLWithPath: args[1]))!
let scale = args.count > 3 ? CGFloat(Double(args[3])!) : 1.5
for i in 0..<doc.pageCount {
  let page = doc.page(at: i)!
  let box = page.bounds(for: .mediaBox)
  let size = NSSize(width: box.width * scale, height: box.height * scale)
  let image = page.thumbnail(of: size, for: .mediaBox)
  let rep = NSBitmapImageRep(data: image.tiffRepresentation!)!
  try! rep.representation(using: .png, properties: [:])!.write(to: URL(fileURLWithPath: "\(args[2])/page-\(i + 1).png"))
}
print("\(doc.pageCount) pages")
