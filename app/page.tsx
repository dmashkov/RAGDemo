import FileUploader from "@/components/FileUploader";
import Chat from "@/components/Chat";

export default function Page() {
  return (
    <main className="space-y-6">
      <FileUploader />
      <Chat />
    </main>
  );
}
