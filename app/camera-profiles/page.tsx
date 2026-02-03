"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ArrowLeft, Camera, Plus, Trash2 } from "lucide-react";

interface CameraProfile {
  id: string;
  name: string;
  description?: string | null;
  fov?: number | null;
  calibratedFocalLength?: number | null;
  opticalCenterX?: number | null;
  opticalCenterY?: number | null;
  createdAt: string;
  team?: { id: string; name: string };
}

export default function CameraProfilesPage() {
  const [profiles, setProfiles] = useState<CameraProfile[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [creating, setCreating] = useState(false);

  const [form, setForm] = useState({
    name: "",
    description: "",
    fov: "",
    calibratedFocalLength: "",
    opticalCenterX: "",
    opticalCenterY: "",
  });

  const fetchProfiles = async () => {
    try {
      setLoading(true);
      const res = await fetch("/api/camera-profiles");
      if (!res.ok) {
        throw new Error("Failed to load camera profiles");
      }
      const data = await res.json();
      setProfiles(data.profiles || []);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load profiles");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchProfiles();
  }, []);

  const createProfile = async () => {
    if (!form.name.trim()) return;
    setCreating(true);
    try {
      const res = await fetch("/api/camera-profiles", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: form.name.trim(),
          description: form.description.trim(),
          fov: form.fov ? Number(form.fov) : undefined,
          calibratedFocalLength: form.calibratedFocalLength
            ? Number(form.calibratedFocalLength)
            : undefined,
          opticalCenterX: form.opticalCenterX ? Number(form.opticalCenterX) : undefined,
          opticalCenterY: form.opticalCenterY ? Number(form.opticalCenterY) : undefined,
        }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || "Failed to create profile");
      }
      setForm({
        name: "",
        description: "",
        fov: "",
        calibratedFocalLength: "",
        opticalCenterX: "",
        opticalCenterY: "",
      });
      setCreateOpen(false);
      await fetchProfiles();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create profile");
    } finally {
      setCreating(false);
    }
  };

  const deleteProfile = async (profileId: string) => {
    if (!confirm("Delete this camera profile?")) return;
    try {
      const res = await fetch(`/api/camera-profiles/${profileId}`, { method: "DELETE" });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || "Failed to delete profile");
      }
      await fetchProfiles();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to delete profile");
    }
  };

  return (
    <div className="min-h-screen bg-gray-50">
      <header className="bg-white border-b border-gray-200">
        <div className="container mx-auto px-4 py-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center space-x-4">
              <Link href="/dashboard">
                <Button variant="ghost" size="sm">
                  <ArrowLeft className="w-4 h-4 mr-2" />
                  Back to Dashboard
                </Button>
              </Link>
              <div className="flex items-center space-x-2">
                <div className="w-8 h-8 bg-gradient-to-r from-green-500 to-blue-500 rounded-lg" />
                <span className="text-xl font-bold bg-gradient-to-r from-green-600 to-blue-600 bg-clip-text text-transparent">
                  AgriDrone Ops
                </span>
              </div>
            </div>
            <Dialog open={createOpen} onOpenChange={setCreateOpen}>
              <DialogTrigger asChild>
                <Button className="bg-gradient-to-r from-green-500 to-blue-500 hover:from-green-600 hover:to-blue-600">
                  <Plus className="w-4 h-4 mr-2" />
                  New Profile
                </Button>
              </DialogTrigger>
              <DialogContent className="max-w-lg">
                <DialogHeader>
                  <DialogTitle>Create Camera Profile</DialogTitle>
                  <DialogDescription>
                    Save camera calibration values to reuse across uploads.
                  </DialogDescription>
                </DialogHeader>
                <div className="space-y-4">
                  <div>
                    <Label htmlFor="profile-name">Profile Name</Label>
                    <Input
                      id="profile-name"
                      value={form.name}
                      onChange={(event) => setForm({ ...form, name: event.target.value })}
                      placeholder="e.g. DJI M4E Wide"
                    />
                  </div>
                  <div>
                    <Label htmlFor="profile-description">Description</Label>
                    <Input
                      id="profile-description"
                      value={form.description}
                      onChange={(event) => setForm({ ...form, description: event.target.value })}
                      placeholder="Optional notes"
                    />
                  </div>
                  <div className="grid gap-4 md:grid-cols-2">
                    <div>
                      <Label htmlFor="profile-fov">Field of View (deg)</Label>
                      <Input
                        id="profile-fov"
                        type="number"
                        min={1}
                        max={180}
                        step="0.1"
                        value={form.fov}
                        onChange={(event) => setForm({ ...form, fov: event.target.value })}
                      />
                    </div>
                    <div>
                      <Label htmlFor="profile-focal">Calibrated Focal Length (px)</Label>
                      <Input
                        id="profile-focal"
                        type="number"
                        step="0.01"
                        value={form.calibratedFocalLength}
                        onChange={(event) =>
                          setForm({ ...form, calibratedFocalLength: event.target.value })
                        }
                      />
                    </div>
                  </div>
                  <div className="grid gap-4 md:grid-cols-2">
                    <div>
                      <Label htmlFor="profile-ocx">Optical Center X (px)</Label>
                      <Input
                        id="profile-ocx"
                        type="number"
                        step="0.01"
                        value={form.opticalCenterX}
                        onChange={(event) =>
                          setForm({ ...form, opticalCenterX: event.target.value })
                        }
                      />
                    </div>
                    <div>
                      <Label htmlFor="profile-ocy">Optical Center Y (px)</Label>
                      <Input
                        id="profile-ocy"
                        type="number"
                        step="0.01"
                        value={form.opticalCenterY}
                        onChange={(event) =>
                          setForm({ ...form, opticalCenterY: event.target.value })
                        }
                      />
                    </div>
                  </div>
                </div>
                <div className="flex justify-end gap-2 pt-4">
                  <Button variant="outline" onClick={() => setCreateOpen(false)}>
                    Cancel
                  </Button>
                  <Button onClick={createProfile} disabled={creating || !form.name.trim()}>
                    {creating ? "Creating..." : "Create Profile"}
                  </Button>
                </div>
              </DialogContent>
            </Dialog>
          </div>
        </div>
      </header>

      <main className="container mx-auto px-4 py-8">
        <div className="mb-6">
          <h1 className="text-3xl font-bold text-gray-900 mb-2">Camera Profiles</h1>
          <p className="text-gray-600">
            Reuse calibration values to improve geo accuracy across flights.
          </p>
        </div>

        {error && (
          <div className="mb-4 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700">
            {error}
          </div>
        )}

        {loading ? (
          <p className="text-gray-500">Loading profiles...</p>
        ) : profiles.length === 0 ? (
          <Card className="text-center py-12">
            <CardContent>
              <p className="text-gray-500 mb-4">No camera profiles yet.</p>
              <Button onClick={() => setCreateOpen(true)}>Create your first profile</Button>
            </CardContent>
          </Card>
        ) : (
          <div className="grid md:grid-cols-2 gap-6">
            {profiles.map((profile) => (
              <Card key={profile.id} className="border-gray-200">
                <CardHeader className="pb-2">
                  <CardTitle className="flex items-center gap-2 text-lg">
                    <Camera className="w-4 h-4 text-green-600" />
                    {profile.name}
                  </CardTitle>
                  {profile.description && (
                    <CardDescription>{profile.description}</CardDescription>
                  )}
                </CardHeader>
                <CardContent className="space-y-2 text-sm text-gray-600">
                  <div className="grid grid-cols-2 gap-2">
                    <div>
                      <span className="text-xs text-gray-500">FOV</span>
                      <p>{profile.fov ?? "—"}</p>
                    </div>
                    <div>
                      <span className="text-xs text-gray-500">Focal Length</span>
                      <p>{profile.calibratedFocalLength ?? "—"}</p>
                    </div>
                    <div>
                      <span className="text-xs text-gray-500">Optical Center X</span>
                      <p>{profile.opticalCenterX ?? "—"}</p>
                    </div>
                    <div>
                      <span className="text-xs text-gray-500">Optical Center Y</span>
                      <p>{profile.opticalCenterY ?? "—"}</p>
                    </div>
                  </div>
                  <div className="flex items-center justify-between pt-2">
                    <span className="text-xs text-gray-400">
                      Team: {profile.team?.name || "—"}
                    </span>
                    <Button
                      variant="outline"
                      size="sm"
                      className="text-red-600 border-red-200 hover:bg-red-50"
                      onClick={() => deleteProfile(profile.id)}
                    >
                      <Trash2 className="w-4 h-4 mr-2" />
                      Delete
                    </Button>
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        )}
      </main>
    </div>
  );
}
